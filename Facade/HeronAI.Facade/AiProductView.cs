using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text.Json;
using Avalonia.Controls;
using Avalonia.Platform;
using Avalonia.Threading;
using Microsoft.Extensions.Logging;
using Microsoft.Web.WebView2.Core;

namespace HeronAI.Facade;

/// <summary>A host-neutral WebView over HeronAI. Multiple views share one runtime and session state.</summary>
public sealed class AiProductView : UserControl
{
    private static readonly JsonSerializerOptions WebJson = new(JsonSerializerDefaults.Web);
    private readonly AiProductRuntime _runtime;
    private readonly NativeWebView _browser = new() { IsVisible = false };
    private readonly bool _manageBrowserVisibility;
    private readonly Stopwatch _startupClock = new();
    private readonly string _viewId = Guid.NewGuid().ToString("N")[..8];
    private readonly Stopwatch _environmentClock = new();
    private long _navigationAt;
    private bool _hasEnvironmentRequest;
    private bool _hasNavigation;
    private IDisposable? _readyTimeout;
    private readonly string? _view;
    private readonly Dictionary<string, TaskCompletionSource<JsonElement>> _pending = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _chatTransferGate = new(1, 1);
    private readonly Dictionary<string, TaskCompletionSource> _chatTransfers = new(StringComparer.Ordinal);
    private TaskCompletionSource _chatPageReady = NewReady();
    private TaskCompletionSource _presentationReady = NewReady();
    private bool _started;
    private bool _disposed;
    private CoreWebView2? _windowsBrowser;
    private AiWebViewInputDiagnostics? _inputDiagnostics;
    private TaskCompletionSource<CoreWebView2?> _windowsBrowserReady = NewWindowsBrowserReady();

    public AiProductView(AiProductRuntime runtime, string? view = null, bool manageBrowserVisibility = true)
    {
        _runtime = runtime;
        _view = view;
        _manageBrowserVisibility = manageBrowserVisibility;
        Content = _browser;
        _browser.EnvironmentRequested += OnEnvironmentRequested;
        _browser.NewWindowRequested += OnNewWindowRequested;
        _browser.WebMessageReceived += OnWebMessageReceived;
        _browser.NavigationStarted += OnNavigationStarted;
        _browser.NavigationCompleted += OnNavigationCompleted;
        _browser.AdapterCreated += OnAdapterCreated;
        _browser.AdapterDestroyed += OnAdapterDestroyed;
        AttachedToVisualTree += (_, _) =>
        {
            if (_started) return;
            _started = true;
            _ = NavigateWhenReadyAsync();
        };
    }

    public NativeWebView Browser => _browser;
    public bool IsReady => _presentationReady.Task.IsCompletedSuccessfully;
    public event Action? PresentationReady;
    public event Action? LoadStateChanged;
    public bool HasLoadFailed { get; private set; }

    private async Task NavigateWhenReadyAsync()
    {
        BeginLoading();
        try
        {
            var waitStarted = Stopwatch.GetTimestamp();
            var uri = await _runtime.StartAsync();
            if (_disposed) return;
            LogStartupStage("runtime-available", (long)Stopwatch.GetElapsedTime(waitStarted).TotalMilliseconds);
            if (_view == "session") uri = new UriBuilder(uri) { Fragment = "heron-ai-view=session" }.Uri;
            await NavigateAsync(uri);
        }
        catch (Exception error) { FailLoading("runtime-failed", error.GetType().Name); }
    }

    public async Task<JsonElement> RequestPresentationAsync(string action, object? value = null, CancellationToken token = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(TimeSpan.FromSeconds(45));
        await _presentationReady.Task.WaitAsync(timeout.Token);
        var id = Guid.NewGuid().ToString("N");
        var pending = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending.Add(id, pending);
        try
        {
            var request = JsonSerializer.Serialize(new { id, action, value }, WebJson);
            await _browser.InvokeScript($"window.heronAiPresentation.request({request})").WaitAsync(timeout.Token);
            return await pending.Task.WaitAsync(timeout.Token);
        }
        finally { _pending.Remove(id); }
    }

    public async Task OpenSessionAsync(string sessionId, CancellationToken token = default)
    {
        await RequestPresentationAsync("open", new { sessionId }, token);
    }

    public async Task ReloadRuntimeAsync(CancellationToken token = default)
    {
        // An unopened view will navigate to the current runtime on first attach.
        if (!_started || _disposed) return;
        BeginLoading();
        try
        {
            var waitStarted = Stopwatch.GetTimestamp();
            var uri = await _runtime.StartAsync(token);
            if (_disposed) return;
            LogStartupStage("runtime-available", (long)Stopwatch.GetElapsedTime(waitStarted).TotalMilliseconds);
            // Manual hot reload keeps the port and host token; force an actual document navigation too.
            var refresh = new UriBuilder(uri);
            refresh.Query = refresh.Query.TrimStart('?') + (refresh.Query.Length > 0 ? "&" : "") + "heron-ai-reload=" + Guid.NewGuid().ToString("N");
            uri = refresh.Uri;
            if (_view == "session") uri = new UriBuilder(uri) { Fragment = "heron-ai-view=session" }.Uri;
            await NavigateAsync(uri);
        }
        catch (Exception error)
        {
            FailLoading("runtime-failed", error.GetType().Name);
            throw;
        }
    }

    private async Task NavigateAsync(Uri uri)
    {
        if (OperatingSystem.IsWindows())
        {
            var browser = await _windowsBrowserReady.Task.WaitAsync(TimeSpan.FromSeconds(30));
            if (_disposed) return;
            if (browser != null) await AiWebViewAuthentication.PrepareAsync(browser, uri, _runtime.Logger);
            if (_inputDiagnostics != null) await _inputDiagnostics.PrepareAsync();
        }
        if (!_disposed) _browser.Navigate(uri);
    }

    private static TaskCompletionSource<CoreWebView2?> NewWindowsBrowserReady() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    public async Task OpenAutomationSessionAsync(AiChatTransferSession session, string draft, CancellationToken token)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(token);
        lifetime.CancelAfter(TimeSpan.FromSeconds(60));
        var cancellationToken = lifetime.Token;
        var acquired = false;
        var id = Guid.NewGuid().ToString("N");
        try
        {
            await _chatTransferGate.WaitAsync(cancellationToken);
            acquired = true;
            await _chatPageReady.Task.WaitAsync(cancellationToken);
            var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            _chatTransfers.Add(id, completion);
            var request = JsonSerializer.Serialize(new
            {
                id, provider = session.Provider, sessionId = session.SessionId,
                workspace = session.Workspace, model = session.Model, title = session.Title, draft
            }, WebJson);
            await _browser.InvokeScript($"window.heronAiOpenAutomationSession({request})").WaitAsync(cancellationToken);
            await completion.Task.WaitAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            throw new TimeoutException("AI automation chat transfer exceeded 60 seconds.");
        }
        finally
        {
            _chatTransfers.Remove(id);
            try { await _browser.InvokeScript($"window.heronAiCancelAutomationSession('{id}')").WaitAsync(TimeSpan.FromSeconds(2)); }
            catch { }
            if (acquired) _chatTransferGate.Release();
        }
    }
    public async Task ApplyThemeAsync(string mode)
    {
        if (mode is not ("light" or "dark")) return;
        try { await _browser.InvokeScript($"window.postMessage('heron-ai-theme:{mode}','*')"); }
        catch { }
    }

    private void OnEnvironmentRequested(object? sender, WebViewEnvironmentRequestedEventArgs args)
    {
        _environmentClock.Restart();
        _hasEnvironmentRequest = true;
        LogStartupStage("webview-environment-requested");
        if (args is not WindowsWebView2EnvironmentRequestedEventArgs windows) return;
        windows.UserDataFolder = _runtime.WebViewProfileDirectory;
        Directory.CreateDirectory(windows.UserDataFolder);
    }

    private async void OnNewWindowRequested(object? sender, WebViewNewWindowRequestedEventArgs args)
    {
        // WebView2 denies every new window the app does not claim. Handle first so an
        // unclaimed request (or one whose URI fails validation) is never a silent no-op.
        args.Handled = true;
        if (args.Request is not { IsAbsoluteUri: true, Scheme: "http" or "https" } uri)
        {
            ReportBrowserDiagnostic("popup-skipped", $"reason={(args.Request == null ? "uri-absent" : "unsupported-scheme")}");
            return;
        }
        ReportBrowserDiagnostic("popup-requested", $"scheme={uri.Scheme} loopback={uri.IsLoopback}");
        try
        {
            await _runtime.OpenExternalUrlAsync(uri, _viewId, _view ?? "workspace");
        }
        catch (OperationCanceledException) { }
        catch (Exception error)
        {
            ReportBrowserDiagnostic("webview-fallback-failed", $"errorType={error.GetType().Name} hresult={error.HResult}");
        }
    }

    private void ReportBrowserDiagnostic(string stage, string detail) =>
        _runtime.ReportBrowserDiagnostic(_viewId, _view ?? "workspace", stage, detail);

    private void OnWindowsNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs args)
    {
        // Observe the native event independently of Avalonia's adapter; never claim it here.
        var scheme = Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" or "about"
            ? uri.Scheme : "other";
        ReportBrowserDiagnostic("native-popup-requested", $"scheme={scheme} userInitiated={args.IsUserInitiated} handled={args.Handled}");
    }

    private void OnNavigationStarted(object? sender, WebViewNavigationStartingEventArgs args)
    {
        if (IsReady || HasLoadFailed) BeginLoading();
        _navigationAt = _startupClock.ElapsedMilliseconds;
        _hasNavigation = true;
        LogStartupStage("navigation-started");
        if (_presentationReady.Task.IsCompleted) _presentationReady = NewReady();
        foreach (var pending in _pending.Values) pending.TrySetException(new IOException("HeronAI page navigated during a session-view request."));
        if (_chatPageReady.Task.IsCompleted) _chatPageReady = NewReady();
        foreach (var pending in _chatTransfers.Values) pending.TrySetException(new IOException("HeronAI page navigated during an automation chat transfer."));
    }

    private void OnAdapterCreated(object? sender, EventArgs args)
    {
        LogStartupStage("webview-adapter-created", _hasEnvironmentRequest
            ? _environmentClock.ElapsedMilliseconds : null);
        if (OperatingSystem.IsWindows()) AttachWindowsNavigationDiagnostics();
    }

    [SupportedOSPlatform("windows")]
    private void AttachWindowsNavigationDiagnostics()
    {
        if (_browser.TryGetPlatformHandle() is not IWindowsWebView2PlatformHandle handle)
        {
            _windowsBrowserReady.TrySetResult(null);
            return;
        }
        var pointer = handle.CoreWebView2;
        try
        {
            _windowsBrowser = CoreWebView2.CreateFromComICoreWebView2(pointer);
            _windowsBrowser.NavigationCompleted += OnWindowsNavigationCompleted;
            _windowsBrowser.NewWindowRequested += OnWindowsNewWindowRequested;
            _inputDiagnostics = new AiWebViewInputDiagnostics(_windowsBrowser, _browser, _runtime.Logger, _viewId, _view ?? "workspace");
            _windowsBrowserReady.TrySetResult(_windowsBrowser);
        }
        catch (Exception error) when (error is COMException or InvalidOperationException)
        {
            _runtime.Logger.LogWarning("AI WebView navigation diagnostics unavailable ErrorType={ErrorType}", error.GetType().Name);
            _windowsBrowserReady.TrySetResult(null);
        }
        finally { if (pointer != IntPtr.Zero) Marshal.Release(pointer); }
    }

    private void OnWindowsNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs args)
    {
        if (!args.IsSuccess)
            _runtime.Logger.LogWarning("AI WebView navigation failed View={View} Status={Status} HttpStatus={HttpStatus}",
                _view ?? "workspace", args.WebErrorStatus, args.HttpStatusCode);
    }

    private void OnAdapterDestroyed(object? sender, EventArgs args)
    {
        if (OperatingSystem.IsWindows()) _inputDiagnostics?.Dispose();
        _inputDiagnostics = null;
        var browser = _windowsBrowser;
        _windowsBrowser = null;
        if (_disposed) _windowsBrowserReady.TrySetCanceled();
        else
        {
            _windowsBrowserReady.TrySetResult(null);
            _windowsBrowserReady = NewWindowsBrowserReady();
        }
        if (browser == null) return;
        try
        {
            browser.NavigationCompleted -= OnWindowsNavigationCompleted;
            browser.NewWindowRequested -= OnWindowsNewWindowRequested;
        }
        catch (Exception error) when (error is COMException or InvalidOperationException) { }
    }

    private void OnNavigationCompleted(object? sender, WebViewNavigationCompletedEventArgs args)
    {
        if (_disposed) return;
        LogStartupStage(args.IsSuccess ? "navigation-completed" : "navigation-failed",
            _hasNavigation ? _startupClock.ElapsedMilliseconds - _navigationAt : null);
        if (!args.IsSuccess) FailLoading("navigation-failed");
    }

    private void BeginLoading()
    {
        if (_disposed) return;
        _startupClock.Restart();
        _hasNavigation = false;
        HasLoadFailed = false;
        if (_presentationReady.Task.IsCompleted) _presentationReady = NewReady();
        if (_manageBrowserVisibility) _browser.IsVisible = false;
        _readyTimeout?.Dispose();
        _readyTimeout = DispatcherTimer.RunOnce(() => FailLoading("presentation-timeout"), TimeSpan.FromSeconds(45));
        LogStartupStage("view-loading");
        LoadStateChanged?.Invoke();
    }

    private void FailLoading(string stage, string? errorType = null)
    {
        if (_disposed || HasLoadFailed) return;
        _readyTimeout?.Dispose();
        _readyTimeout = null;
        HasLoadFailed = true;
        _runtime.Logger.LogWarning("AI startup ViewId={ViewId} View={View} Stage={Stage} ElapsedMs={ElapsedMs} ErrorType={ErrorType}",
            _viewId, _view ?? "workspace", stage, _startupClock.ElapsedMilliseconds, errorType);
        LoadStateChanged?.Invoke();
    }

    private void LogStartupStage(string stage, long? stageElapsedMs = null) => _runtime.Logger.LogInformation(
        "AI startup ViewId={ViewId} View={View} Stage={Stage} ElapsedMs={ElapsedMs} StageElapsedMs={StageElapsedMs}",
        _viewId, _view ?? "workspace", stage, _startupClock.ElapsedMilliseconds, stageElapsedMs);

    private void OnWebMessageReceived(object? sender, WebMessageReceivedEventArgs args)
    {
        if (_disposed || string.IsNullOrWhiteSpace(args.Body)) return;
        try
        {
            using var body = JsonDocument.Parse(args.Body);
            using var message = body.RootElement.ValueKind == JsonValueKind.String
                ? JsonDocument.Parse(body.RootElement.GetString()!) : JsonDocument.Parse(args.Body);
            var root = message.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("event", out var eventType) || eventType.ValueKind != JsonValueKind.String) return;
            switch (eventType.GetString())
            {
                case "heron-ai-external-link-click":
                    var scheme = root.TryGetProperty("scheme", out var linkScheme) && linkScheme.ValueKind == JsonValueKind.String
                        && linkScheme.GetString() is "http" or "https" ? linkScheme.GetString() : "other";
                    ReportBrowserDiagnostic("link-click", $"scheme={scheme} targetBlank={root.TryGetProperty("targetBlank", out var blank) && blank.ValueKind == JsonValueKind.True} trusted={root.TryGetProperty("trusted", out var trusted) && trusted.ValueKind == JsonValueKind.True} prevented={root.TryGetProperty("prevented", out var prevented) && prevented.ValueKind == JsonValueKind.True}");
                    break;
                case "heron-ai-chat-ready":
                    if (!_chatPageReady.Task.IsCompleted) LogStartupStage("chat-ready");
                    _chatPageReady.TrySetResult();
                    break;
                case "heron-ai-chat-transfer-result":
                    if (root.TryGetProperty("id", out var transferId) && transferId.ValueKind == JsonValueKind.String &&
                        _chatTransfers.TryGetValue(transferId.GetString() ?? "", out var transfer))
                    {
                        if (root.TryGetProperty("ok", out var success) && success.ValueKind == JsonValueKind.True) transfer.TrySetResult();
                        else transfer.TrySetException(new InvalidOperationException(root.TryGetProperty("error", out var error) ? error.GetString() ?? "Automation transfer failed." : "Automation transfer failed."));
                    }
                    break;
                case "heron-ai-presentation-ready":
                    if (IsReady) break;
                    LogStartupStage("presentation-ready", _hasNavigation
                        ? _startupClock.ElapsedMilliseconds - _navigationAt : null);
                    _readyTimeout?.Dispose();
                    _readyTimeout = null;
                    HasLoadFailed = false;
                    _presentationReady.TrySetResult();
                    if (_manageBrowserVisibility) _browser.IsVisible = true;
                    LoadStateChanged?.Invoke();
                    PresentationReady?.Invoke();
                    break;
                case "heron-ai-presentation-result":
                    if (!root.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String ||
                        !_pending.TryGetValue(id.GetString() ?? "", out var completion)) return;
                    if (root.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True && root.TryGetProperty("value", out var result))
                        completion.TrySetResult(result.Clone());
                    else completion.TrySetException(new InvalidOperationException("HeronAI presentation request failed."));
                    break;
            }
        }
        catch (JsonException) { }
    }

    private static TaskCompletionSource NewReady() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _readyTimeout?.Dispose();
        _browser.EnvironmentRequested -= OnEnvironmentRequested;
        _browser.NewWindowRequested -= OnNewWindowRequested;
        _browser.WebMessageReceived -= OnWebMessageReceived;
        _browser.NavigationStarted -= OnNavigationStarted;
        _browser.NavigationCompleted -= OnNavigationCompleted;
        _browser.AdapterCreated -= OnAdapterCreated;
        _browser.AdapterDestroyed -= OnAdapterDestroyed;
        OnAdapterDestroyed(this, EventArgs.Empty);
        _presentationReady.TrySetCanceled();
        foreach (var pending in _pending.Values) pending.TrySetCanceled();
        foreach (var pending in _chatTransfers.Values) pending.TrySetCanceled();
        _chatTransferGate.Dispose();
        _pending.Clear();
    }
}
