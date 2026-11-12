using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Reflection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace HeronAI.Facade;

public sealed record AiProductOptions(string ProductRoot, string StateDirectory, string? ServerUrl = null,
    string? LocalRoot = null, string Theme = "light", string? NodeExecutable = null,
    string? WebViewProfileDirectory = null, string? HostIntegration = null,
    Func<CancellationToken, Task<string>>? PrepareRuntime = null, string? HostEdition = null)
{
    public string? HostSource { get; init; }
    public string? HostVersion { get; init; }
    public string? ConfigurationFile { get; init; }
}

/// <summary>Owns the independent HeronAI Node runtime and its ready/stdin/stdout protocol.</summary>
public sealed partial class AiProductRuntime : IAsyncDisposable
{
    private readonly AiProductOptions _options;
    private string _productRoot;
    private readonly object _stdinLock = new();
    private readonly AiExternalBrowser _externalBrowser;
    private readonly SemaphoreSlim _startGate = new(1, 1);
    private Process? _process;
    private Task? _stdoutTask;
    private Task? _stderrTask;
    private CancellationTokenSource? _lifetime;
    private TaskCompletionSource<Uri> _ready = NewReady();
    private bool _disposed;
    private readonly Stopwatch _startupClock = new();
    private string _startupId = "";
    // Per-launch host control token; only this process and the sidecar know it.
    private string _hostToken = "";
    private static readonly HttpClient HostClient = new() { Timeout = TimeSpan.FromSeconds(15) };

    public AiProductRuntime(AiProductOptions options, ILogger? logger = null)
    {
        _options = options;
        _productRoot = options.ProductRoot;
        Logger = logger ?? NullLogger.Instance;
        _developmentHmr = ReadDevelopmentHmr();
        _externalBrowser = new AiExternalBrowser(StateDirectory, WebViewProfileDirectory, ReportBrowserDiagnostic);
    }
    internal ILogger Logger { get; }
    public event Action<JsonElement>? EventReceived;
    public event Action<Process>? ProcessStarted;
    public event Action<string>? DiagnosticReceived;
    public event Action<Exception>? StartupFailed;
    internal void ReportBrowserDiagnostic(string viewId, string view, string stage, string detail)
    {
        Logger.LogInformation("AI browser ViewId={ViewId} View={View} Stage={Stage} {Detail}", viewId, view, stage, detail);
        DiagnosticReceived?.Invoke($"[browser] ViewId={viewId} View={view} Stage={stage} {detail}");
    }
    internal Task<string> OpenExternalUrlAsync(Uri uri, string viewId, string view) =>
        _externalBrowser.OpenAsync(uri, viewId, view, _lifetime?.Token ?? CancellationToken.None);
    public Process? Process => _process;
    public bool IsRunning => _process is { HasExited: false };
    public string StateDirectory => Path.GetFullPath(_options.StateDirectory);
    public string WebViewProfileDirectory => Path.GetFullPath(_options.WebViewProfileDirectory ?? Path.Combine(StateDirectory, "cache", "webview2"));

    public async Task<Uri> StartAsync(CancellationToken cancellationToken = default)
    {
        await _startGate.WaitAsync(cancellationToken);
        try { return await StartCoreAsync(cancellationToken); }
        finally { _startGate.Release(); }
    }

    private async Task<Uri> StartCoreAsync(CancellationToken cancellationToken, bool prepareRuntime = true)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (IsRunning) return await _ready.Task.WaitAsync(cancellationToken);
        // Drain the previous process readers before replacing the shared ready source.
        await StopCoreAsync();
        _startupId = Guid.NewGuid().ToString("N")[..8];
        _startupClock.Restart();
        LogStartupStage("runtime-starting");
        _lifetime?.Dispose();
        _lifetime = new CancellationTokenSource();
        using var startup = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _lifetime.Token);
        try
        {
            if (prepareRuntime && _options.PrepareRuntime != null)
            {
                _productRoot = await _options.PrepareRuntime(startup.Token);
                LogStartupStage("runtime-prepared");
            }
            startup.Token.ThrowIfCancellationRequested();
            ObjectDisposedException.ThrowIf(_disposed, this);
            var productRoot = Path.GetFullPath(_productRoot);
            var host = Path.Combine(productRoot, "AiHost", "main.mjs");
            if (!File.Exists(host)) throw new FileNotFoundException("HeronAI runtime is missing; build the product first.", host);
            Directory.CreateDirectory(StateDirectory);
            var node = ResolveNode(productRoot);
            var start = new ProcessStartInfo { FileName = node, WorkingDirectory = productRoot,
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false), StandardErrorEncoding = new UTF8Encoding(false) };
            start.ArgumentList.Add(host);
            if (_options.ConfigurationFile is { } configurationFile)
            {
                start.ArgumentList.Add("--config"); start.ArgumentList.Add(Path.GetFullPath(configurationFile));
            }
            start.ArgumentList.Add("--state-dir"); start.ArgumentList.Add(StateDirectory);
            start.ArgumentList.Add("--local-root"); start.ArgumentList.Add(Path.GetFullPath(_options.LocalRoot ?? StateDirectory));
            if (_options.HostEdition is { } edition) { start.ArgumentList.Add("--host-edition"); start.ArgumentList.Add(edition); }
            start.ArgumentList.Add("--host-theme"); start.ArgumentList.Add(_options.Theme);
            if (!string.IsNullOrWhiteSpace(_options.ServerUrl)) { start.ArgumentList.Add("--server-url"); start.ArgumentList.Add(_options.ServerUrl); }
            if (_options.HostIntegration is { Length: > 0 } integration) { start.ArgumentList.Add("--host-integration"); start.ArgumentList.Add(integration); }
            _hostToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
            start.ArgumentList.Add("--token"); start.ArgumentList.Add(_hostToken);
            if (!IsDebugHost && DevelopmentHmrEnabled)
            {
                start.ArgumentList.Add("--development-hmr"); start.ArgumentList.Add("true");
            }
            start.Environment["NODE_COMPILE_CACHE"] = Path.Combine(StateDirectory, "runtime", "node-compile-cache");
            start.Environment["HERON_AI_PRODUCT_ROOT"] = productRoot;
            if (OperatingSystem.IsWindows() && Avalonia.Application.Current != null)
                start.Environment["DSH_EXTERNAL_BROWSER_BRIDGE"] = "stdio-v1";
            var entry = Assembly.GetEntryAssembly();
            var configuration = entry?.GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration.ToLowerInvariant();
            start.Environment["HERON_AI_HOST_METADATA"] = JsonSerializer.Serialize(new
            {
                source = _options.HostSource ?? "unknown",
                version = _options.HostVersion ?? entry?.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0],
                build = configuration is "debug" or "release" ? configuration : "unknown"
            });
            Directory.CreateDirectory(start.Environment["NODE_COMPILE_CACHE"]!);
            _ready = NewReady();
            var process = new Process { StartInfo = start, EnableRaisingEvents = true };
            if (!process.Start()) throw new InvalidOperationException("HeronAI runtime failed to start.");
            _process = process;
            LogStartupStage("process-started");
            ProcessStarted?.Invoke(process);
            _stdoutTask = ReadStdoutAsync(process, _lifetime.Token);
            _stderrTask = ReadStderrAsync(process, _lifetime.Token);
            return await _ready.Task.WaitAsync(TimeSpan.FromSeconds(30), startup.Token);
        }
        catch (OperationCanceledException) when (startup.IsCancellationRequested)
        {
            await StopCoreAsync();
            throw;
        }
        catch (Exception error)
        {
            Logger.LogWarning(error, "AI startup RuntimeId={RuntimeId} Stage=runtime-failed ElapsedMs={ElapsedMs} ErrorType={ErrorType}",
                _startupId, _startupClock.ElapsedMilliseconds, error.GetType().Name);
            StartupFailed?.Invoke(error);
            await StopCoreAsync();
            throw;
        }
    }

    private string ResolveNode(string productRoot)
    {
        if (!string.IsNullOrWhiteSpace(_options.NodeExecutable)) return Path.GetFullPath(_options.NodeExecutable);
        var bundled = new[] { Path.Combine(productRoot, "node", "node.exe"),
            Path.Combine(Path.GetDirectoryName(productRoot)!, "node", "node.exe") };
        var node = bundled.FirstOrDefault(File.Exists);
        if (node != null) return node;
        return OperatingSystem.IsWindows() ? "node.exe" : "node";
    }

    private async Task ReadStdoutAsync(Process process, CancellationToken token)
    {
        try
        {
            while (!token.IsCancellationRequested && await process.StandardOutput.ReadLineAsync(token) is { } line)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                try
                {
                    using var document = JsonDocument.Parse(line);
                    var value = document.RootElement.Clone();
                    if (value.TryGetProperty("event", out var browserKind) && browserKind.GetString() == "external-browser-request")
                    {
                        _ = HandleExternalBrowserRequestAsync(process, value, token);
                        continue;
                    }
                    if (value.TryGetProperty("event", out var kind) && kind.GetString() == "ready")
                    {
                        if (!value.TryGetProperty("port", out var portValue) || !portValue.TryGetInt32(out var port) || port is < 1 or > 65535 ||
                            !value.TryGetProperty("url", out var url) || !Uri.TryCreate(url.GetString(), UriKind.Absolute, out var uri) ||
                            uri.Scheme != Uri.UriSchemeHttp || uri.Port != port || !string.IsNullOrEmpty(uri.UserInfo) || !IsLoopback(uri.Host))
                            throw new InvalidDataException("HeronAI ready event has an invalid local URL.");
                        _ready.TrySetResult(uri);
                        LogStartupStage("runtime-ready");
                    }
                    EventReceived?.Invoke(value);
                }
                catch (JsonException) { DiagnosticReceived?.Invoke("[stdout] " + line); }
                catch (InvalidDataException error) { _ready.TrySetException(error); }
            }
            if (!_ready.Task.IsCompleted) _ready.TrySetException(new IOException("HeronAI runtime exited before ready."));
        }
        catch (OperationCanceledException) { }
        catch (Exception error) { if (!_ready.Task.IsCompleted) _ready.TrySetException(error); }
    }

    private async Task ReadStderrAsync(Process process, CancellationToken token)
    {
        try { while (!token.IsCancellationRequested && await process.StandardError.ReadLineAsync(token) is { } line) DiagnosticReceived?.Invoke("[stderr] " + line); }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
    }

    private async Task HandleExternalBrowserRequestAsync(Process process, JsonElement request, CancellationToken token)
    {
        if (!request.TryGetProperty("id", out var idValue) || idValue.ValueKind != JsonValueKind.String ||
            !Guid.TryParse(idValue.GetString(), out var id)) return;
        var ok = false;
        var mode = "none";
        try
        {
            if (!request.TryGetProperty("url", out var url) || url.ValueKind != JsonValueKind.String ||
                url.GetString() is not { Length: > 0 and <= 16384 } text || !Uri.TryCreate(text, UriKind.Absolute, out var uri))
                throw new InvalidDataException("Invalid external browser request.");
            mode = await _externalBrowser.OpenAsync(uri, "host", "oauth", token);
            ok = true;
        }
        catch (OperationCanceledException) { return; }
        catch (Exception error) { ReportBrowserDiagnostic("host", "oauth", "webview-fallback-failed", $"errorType={error.GetType().Name}"); }
        try
        {
            lock (_stdinLock)
            {
                if (!ReferenceEquals(_process, process) || process.HasExited) return;
                process.StandardInput.WriteLine(JsonSerializer.Serialize(new { type = "external-browser-result", id = id.ToString(), ok, mode }));
                process.StandardInput.Flush();
            }
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException or InvalidOperationException)
        { ReportBrowserDiagnostic("host", "oauth", "browser-result-not-delivered", $"errorType={error.GetType().Name}"); }
    }

    /// <summary>Replace every preset workspace of one host source on the running sidecar.</summary>
    /// <returns>Validation errors reported by the product for individual candidates.</returns>
    public async Task<IReadOnlyList<string>> PushWorkspacesAsync(string source, IReadOnlyList<AiWorkspaceCandidate> candidates,
        CancellationToken cancellationToken = default)
    {
        var ready = await _ready.Task.WaitAsync(cancellationToken);
        using var request = new HttpRequestMessage(HttpMethod.Put,
            new Uri(new Uri($"http://127.0.0.1:{ready.Port}/"), "heron-ai-host/workspaces/" + Uri.EscapeDataString(source)))
        {
            Content = JsonContent.Create(new { candidates = candidates.Select(item => new
            {
                id = item.Id, name = item.Name, kind = item.Kind, ready = item.Ready,
                projectFile = string.IsNullOrWhiteSpace(item.ProjectFile) ? null : item.ProjectFile,
                roots = item.Roots.Select(root => new { label = root.Label, path = root.Path }),
                adoptSessions = item.AdoptSessions ? true : (bool?)null,
            }) }, options: new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web)
            { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull }),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _hostToken);
        using var response = await HostClient.SendAsync(request, cancellationToken);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException(document.RootElement.TryGetProperty("error", out var error) ? error.GetString() : $"Workspace push failed ({(int)response.StatusCode}).");
        return document.RootElement.TryGetProperty("errors", out var errors) && errors.ValueKind == JsonValueKind.Array
            ? errors.EnumerateArray().Select(item => item.GetString() ?? "").ToArray() : [];
    }

    public void Send(string line)
    {
        var process = _process;
        if (process is not { HasExited: false }) return;
        lock (_stdinLock) { process.StandardInput.WriteLine(line); process.StandardInput.Flush(); }
    }

    public async Task StopAsync()
    {
        await _startGate.WaitAsync();
        try { await StopCoreAsync(); }
        finally { _startGate.Release(); }
    }

    private async Task StopCoreAsync()
    {
        await _externalBrowser.CloseAsync();
        var process = _process;
        if (process == null) { _lifetime?.Cancel(); return; }
        _process = null;
        try
        {
            if (!process.HasExited)
            {
                DiagnosticReceived?.Invoke("[host] Stopping AI runtime");
                try { process.StandardInput.Close(); } catch (IOException) { }
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                try { await process.WaitForExitAsync(timeout.Token); }
                catch (OperationCanceledException) { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); }
            }
            DiagnosticReceived?.Invoke($"[host] AI process exited · code {process.ExitCode}");
        }
        finally
        {
            _lifetime?.Cancel();
            try { if (_stdoutTask != null) await _stdoutTask; } catch { }
            try { if (_stderrTask != null) await _stderrTask; } catch { }
            _lifetime?.Dispose(); _lifetime = null;
            process.Dispose();
        }
    }

    public async Task RestartAtAsync(string productRoot, CancellationToken cancellationToken = default)
    {
        await _startGate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            await StopCoreAsync();
            _productRoot = Path.GetFullPath(productRoot);
            _ready = NewReady();
            // The caller has already prepared/activated this target; preparation here can select another runtime.
            await StartCoreAsync(cancellationToken, prepareRuntime: false);
        }
        finally { _startGate.Release(); }
    }

    public async Task RestartAsync(CancellationToken cancellationToken = default)
    {
        await _startGate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var prepared = IsRunning;
            DiagnosticReceived?.Invoke("[host] Restarting AI runtime");
            await StopCoreAsync();
            await StartCoreAsync(cancellationToken, prepareRuntime: !prepared);
        }
        finally { _startGate.Release(); }
    }

    public async Task<AiHotReloadResult> HotReloadAsync(CancellationToken cancellationToken = default)
    {
        await _startGate.WaitAsync(cancellationToken);
        try
        {
            var ready = await StartCoreAsync(cancellationToken);
            DiagnosticReceived?.Invoke("[host] Hot reload requested");
            using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(ready, "/heron-ai-host/reload"));
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _hostToken);
            using var response = await HostClient.SendAsync(request, cancellationToken);
            if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
                throw new InvalidOperationException("当前 AI 功能包不支持手动热更新，请更新 AI 功能包。");
            response.EnsureSuccessStatusCode();
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
            var value = document.RootElement;
            return new(value.GetProperty("restartRequired").GetBoolean(), value.GetProperty("pending").GetInt32(),
                value.GetProperty("warnings").GetInt32());
        }
        finally { _startGate.Release(); }
    }

    private static bool IsLoopback(string host) => host is "127.0.0.1" or "localhost" or "[::1]" or "::1";
    private void LogStartupStage(string stage)
    {
        Logger.LogInformation("AI startup RuntimeId={RuntimeId} Stage={Stage} ElapsedMs={ElapsedMs}",
            _startupId, stage, _startupClock.ElapsedMilliseconds);
        DiagnosticReceived?.Invoke($"[host] {stage} {_startupClock.ElapsedMilliseconds}ms");
    }
    private static TaskCompletionSource<Uri> NewReady() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    public async ValueTask DisposeAsync() { if (_disposed) return; _disposed = true; await StopAsync(); }
}

public sealed record AiHotReloadResult(bool RestartRequired, int PendingModules, int Warnings);




