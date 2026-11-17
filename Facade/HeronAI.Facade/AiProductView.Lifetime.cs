using System.Text.Json;
using Avalonia.Threading;
using Microsoft.Extensions.Logging;

namespace HeronAI.Facade;

public sealed partial class AiProductView
{
    private static readonly TimeSpan BrowserIdleTimeout = TimeSpan.FromMinutes(5);
    private readonly CancellationTokenSource _browserLifetime = new();
    private IDisposable? _idleBrowserTimer;
    private bool? _presentationVisible;
    private long _visibilityVersion;
    private bool _browserReleased;
    private bool _resumingBrowser;
    private Task? _releaseBrowserTask;
    private Task? _resumeBrowserTask;
    private JsonElement? _browserPresentation;
    private string? _browserTheme;

    // Observe the outer view, not Browser.IsVisible: the loading overlay hides the
    // native surface while a foreground view is being recreated.
    private bool PresentationVisible => IsEffectivelyVisible && _ownerWindow is { IsVisible: true }
        && _ownerWindow.WindowState != Avalonia.Controls.WindowState.Minimized;

    private void UpdateBrowserLifetime()
    {
        if (!OperatingSystem.IsWindows() || _disposed || !_started) return;
        var visible = PresentationVisible;
        if (_presentationVisible != visible) { _presentationVisible = visible; _visibilityVersion++; }
        if (visible)
        {
            _idleBrowserTimer?.Dispose();
            _idleBrowserTimer = null;
            if (_browserReleased && _releaseBrowserTask == null && _resumeBrowserTask == null)
                _ = EnsureBrowserAsync(CancellationToken.None);
            return;
        }
        if (_browserReleased || _releaseBrowserTask != null || _resumeBrowserTask != null || !IsReady) return;
        _idleBrowserTimer ??= DispatcherTimer.RunOnce(() =>
        {
            _idleBrowserTimer = null;
            _releaseBrowserTask = ReleaseIdleBrowserAsync();
        }, BrowserIdleTimeout);
    }

    private async Task ReleaseIdleBrowserAsync()
    {
        // Yield before work so the task owner is published before any event can reenter.
        await Task.Yield();
        var version = _visibilityVersion;
        try
        {
            if (_disposed || PresentationVisible || !IsReady || _pending.Count != 0 || _chatTransfers.Count != 0) return;
            using var capture = CancellationTokenSource.CreateLinkedTokenSource(_browserLifetime.Token);
            capture.CancelAfter(TimeSpan.FromSeconds(5));
            var state = await RequestPresentationCoreAsync("capture", null, capture.Token);
            // A return to foreground cancels this idle period even if it goes back to
            // background again before the asynchronous state capture finishes.
            if (_disposed || version != _visibilityVersion || PresentationVisible) return;
            if (!state.TryGetProperty("canRelease", out var allowed) || allowed.ValueKind != JsonValueKind.True) return;
            _browserPresentation = state;
            _browserReleased = true;
            _readyTimeout?.Dispose();
            _readyTimeout = null;
            _presentationReady = NewReady();
            _chatPageReady = NewReady();
            var detached = NewReady();
            void OnDetached(object? sender, EventArgs args) => detached.TrySetResult();
            _browser.AdapterDestroyed += OnDetached;
            try
            {
                Content = null; // NativeWebView detachment closes the controller and destroys its adapter.
                await detached.Task.WaitAsync(TimeSpan.FromSeconds(5), _browserLifetime.Token);
            }
            finally { _browser.AdapterDestroyed -= OnDetached; }
            _browser.Source = null;
            _runtime.Logger.LogInformation("AI WebView idle released ViewId={ViewId} View={View} NodePid={NodePid}",
                _viewId, _view ?? "workspace", _runtime.Process?.Id);
        }
        catch (OperationCanceledException) { }
        catch (Exception error)
        {
            _runtime.Logger.LogWarning("AI WebView idle release deferred ViewId={ViewId} ErrorType={ErrorType}",
                _viewId, error.GetType().Name);
        }
        finally
        {
            _releaseBrowserTask = null;
            UpdateBrowserLifetime();
        }
    }

    private async Task EnsureBrowserAsync(CancellationToken token)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_releaseBrowserTask != null) await _releaseBrowserTask.WaitAsync(token);
        if (_browserReleased && _resumeBrowserTask == null) _resumeBrowserTask = ResumeBrowserAsync();
        if (_resumeBrowserTask != null) await _resumeBrowserTask.WaitAsync(token);
    }

    private async Task ResumeBrowserAsync()
    {
        await Task.Yield();
        _resumingBrowser = true;
        try
        {
            if (_disposed) return;
            BeginLoading();
            _browserReleased = false;
            Content = _browser;
            // StartAsync reuses the running Node and its authenticated URL. It does
            // not stop or restart the runtime for browser reclamation.
            var uri = await _runtime.StartAsync(_browserLifetime.Token);
            if (_disposed) return;
            if (_view == "session") uri = new UriBuilder(uri) { Fragment = "heron-ai-view=session" }.Uri;
            await NavigateAsync(uri);
            await _presentationReady.Task.WaitAsync(TimeSpan.FromSeconds(45), _browserLifetime.Token);
            if (_browserPresentation is { } state)
                await RequestPresentationCoreAsync("restore", state, _browserLifetime.Token);
            if (_browserTheme != null) await ApplyThemeAsync(_browserTheme);
            _browserPresentation = null;
            _resumingBrowser = false;
            if (_manageBrowserVisibility) _browser.IsVisible = true;
            LoadStateChanged?.Invoke();
            PresentationReady?.Invoke();
            LogStartupStage("idle-resumed");
        }
        catch (OperationCanceledException) when (_browserLifetime.IsCancellationRequested) { }
        catch (Exception error) { FailLoading("idle-resume-failed", error.GetType().Name); }
        finally
        {
            _resumingBrowser = false;
            _resumeBrowserTask = null;
            UpdateBrowserLifetime();
        }
    }
}
