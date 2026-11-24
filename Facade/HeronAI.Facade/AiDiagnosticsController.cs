using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using Avalonia.Threading;

namespace HeronAI.Facade;

/// <summary>Owns diagnostics log capture, HMR toggling, and restart/hot-reload operations for an <see cref="AiProductRuntime" />.</summary>
public sealed class AiDiagnosticsController : IAsyncDisposable
{
    private readonly AiProductRuntime _runtime;
    private readonly Func<CancellationToken, Task> _reloadViews;
    private readonly AiDiagnosticsLogBuffer _logs = new(2000, 256 * 1024);
    private readonly List<AiDiagnosticsPanel> _panels = [];
    private readonly CancellationTokenSource _lifetime = new();
    private readonly SemaphoreSlim _operation = new(1, 1);
    private long _revision;
    private bool _ready;
    private bool _automaticHmr;
    private bool _busy;
    private bool _disposed;
    private string _message = "重启或热更新会中断受影响的 AI 任务，聊天记录保留。";

    public AiDiagnosticsController(AiProductRuntime runtime, Func<CancellationToken, Task>? reloadViews = null)
    {
        ArgumentNullException.ThrowIfNull(runtime);
        _runtime = runtime;
        _reloadViews = reloadViews ?? (static _ => Task.CompletedTask);
        runtime.DiagnosticReceived += Append;
        runtime.EventReceived += OnEvent;
        runtime.ProcessStarted += OnProcessStarted;
    }

    public string Title => "AI 调试";
    public bool CanOperate => !_disposed && !Volatile.Read(ref _busy);
    public string Message => Volatile.Read(ref _message);
    public bool DevelopmentHmrEnabled => _runtime.DevelopmentHmrEnabled;
    public bool CanConfigureDevelopmentHmr => CanOperate && !_runtime.IsDebugHost;
    public string DevelopmentHmrHint => _runtime.IsDebugHost ? "Debug 版本始终开启 HMR。"
        : !_runtime.IsRunning ? "仅用于本地插件开发；下次启动 AI 时生效。"
        : Volatile.Read(ref _ready) && DevelopmentHmrEnabled != Volatile.Read(ref _automaticHmr)
            ? $"已保存，重启 AI 后{(DevelopmentHmrEnabled ? "开启" : "关闭")} HMR。"
            : "仅用于本地插件开发；修改后需要重启 AI。";
    public long Revision => Interlocked.Read(ref _revision);
    public string Status
    {
        get
        {
            try
            {
                return !_runtime.IsRunning ? "AI 未运行" :
                    $"{(Volatile.Read(ref _ready) ? "运行中" : "启动中")} · PID {_runtime.Process?.Id} · 自动热更新{(Volatile.Read(ref _automaticHmr) ? "已开启" : "已关闭")}";
            }
            catch (InvalidOperationException) { return "AI 未运行"; }
        }
    }
    public string LogText => _logs.GetTailText(1000, 128 * 1024);

    public AiDiagnosticsPanel CreatePanel()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        var panel = new AiDiagnosticsPanel(this);
        _panels.Add(panel);
        return panel;
    }

    public void ReleasePanel(AiDiagnosticsPanel panel)
    {
        ArgumentNullException.ThrowIfNull(panel);
        _panels.Remove(panel);
        panel.Dispose();
    }

    public void Clear()
    {
        _logs.Clear();
        Interlocked.Increment(ref _revision);
    }

    public void SetDevelopmentHmrEnabled(bool enabled)
    {
        if (!CanConfigureDevelopmentHmr) return;
        try
        {
            _runtime.SetDevelopmentHmrEnabled(enabled);
            Append($"[host] 插件开发 HMR 设置为{(enabled ? "开启" : "关闭")}，重启 AI 后生效");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            Volatile.Write(ref _message, "插件开发 HMR 设置保存失败，请查看运行日志。");
            Append("[host] HMR preference save failed: " + error.GetType().Name);
        }
    }

    public void Append(string text)
    {
        if (_disposed) return;
        _logs.Append($"{DateTimeOffset.Now:HH:mm:ss.fff} {Redact(text)}");
        Interlocked.Increment(ref _revision);
    }

    public async Task RunAsync(bool restart)
    {
        if (_disposed || !await _operation.WaitAsync(0, _lifetime.Token)) return;
        Volatile.Write(ref _busy, true);
        var label = restart ? "重启 AI" : "热更新";
        Volatile.Write(ref _message, $"正在{label}…");
        Append($"[host] {label}开始");
        var clock = Stopwatch.StartNew();
        try
        {
            string message;
            if (restart)
            {
                await _runtime.RestartAsync(_lifetime.Token);
                message = "AI 重启完成";
            }
            else
            {
                var result = await _runtime.HotReloadAsync(_lifetime.Token);
                message = !result.RestartRequired ? "热更新完成" : result.PendingModules > 0
                    ? $"热更新完成，仍有 {result.PendingModules} 个模块需要重启 AI"
                    : "热更新完成，启动依赖有变化，请重启 AI";
                if (result.Warnings > 0) message += $"，{result.Warnings} 项插件诊断，请查看运行日志";
            }
            await Dispatcher.UIThread.InvokeAsync(async () => await _reloadViews(_lifetime.Token));
            message += $"（{clock.Elapsed.TotalSeconds:F1} 秒）";
            Volatile.Write(ref _message, message);
            Append("[host] " + message);
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
        catch (Exception error)
        {
            var message = $"{label}失败：{Redact(error.Message)}";
            Volatile.Write(ref _message, message);
            Append("[host] " + message);
        }
        finally { Volatile.Write(ref _busy, false); _operation.Release(); }
    }

    private void OnProcessStarted(Process process)
    {
        Volatile.Write(ref _ready, false);
        Append($"[host] AI process started · PID {process.Id}");
    }

    private void OnEvent(JsonElement value)
    {
        if (!value.TryGetProperty("event", out var kind) || kind.ValueKind != JsonValueKind.String) return;
        switch (kind.GetString())
        {
            case "ready":
                Volatile.Write(ref _ready, true);
                Volatile.Write(ref _automaticHmr, value.TryGetProperty("hmr", out var hmr) && hmr.ValueKind == JsonValueKind.True);
                Append("[stdout] ready");
                break;
            case "activity":
                if (value.TryGetProperty("busy", out var busy)) Append($"[stdout] activity busy={busy.ValueKind == JsonValueKind.True}");
                break;
            default:
                // Structured events can carry authenticated URLs or user data. Only expose their event kind.
                Append("[stdout] event=" + kind.GetString());
                break;
        }
    }

    private static string Redact(string text)
    {
        text = text.Length > 8192 ? text[..8192] : text;
        text = Regex.Replace(text, @"\x1B\[[0-?]*[ -/]*[@-~]", "");
        text = Regex.Replace(text, @"https?://[^\s\""<>]+", "[url]", RegexOptions.IgnoreCase);
        text = Regex.Replace(text, @"Bearer\s+\S+|\b(?:sk|ck|ds)-[A-Za-z0-9_-]+", "[redacted]", RegexOptions.IgnoreCase);
        return Regex.Replace(text, "(?i)([\\\"']?(?:token|password|secret|api[_-]?key|authorization|cookie|shellToken)[\\\"']?\\s*[:=]\\s*)(\\\"[^\\\"]*\\\"|'[^']*'|[^\\s,;}]+)", "$1[redacted]");
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        _lifetime.Cancel();
        _runtime.DiagnosticReceived -= Append;
        _runtime.EventReceived -= OnEvent;
        _runtime.ProcessStarted -= OnProcessStarted;
        foreach (var panel in _panels.ToArray()) panel.Dispose();
        _panels.Clear();
        await _operation.WaitAsync();
        _operation.Release();
        _lifetime.Dispose();
    }
}
