using System.Diagnostics;
using System.Runtime.Versioning;
using System.Text.Json;
using Avalonia.Controls;
using Avalonia.Threading;
using Microsoft.Extensions.Logging;
using Microsoft.Web.WebView2.Core;

namespace HeronAI.Facade;

/// <summary>Passive per-view input evidence in the host's existing log, without page content.</summary>
[SupportedOSPlatform("windows")]
internal sealed class AiWebViewInputDiagnostics : IDisposable
{
    private static readonly string[] EventTypes = ["pointerdown", "pointerup", "pointercancel", "click", "contextmenu",
        "dragstart", "dragend", "drop", "gotpointercapture", "lostpointercapture", "focusin", "focusout",
        "wheel", "keydown", "focus", "blur", "visibilitychange", "selectionchange"];
    private static readonly string[] Tags = "html body div span button input textarea select option a pre code p section main aside nav header footer form label ul ol li table tr td svg path other".Split(' ');
    private static readonly string[] Roles = "button textbox dialog menu menuitem tab tabpanel link listbox option tree treeitem status tooltip combobox -".Split(' ');
    private static readonly string[] PointerValues = ["auto", "none", "all", "painted", "visible", "visiblePainted",
        "visibleFill", "visibleStroke", "fill", "stroke", "bounding-box"];
    private const string SnapshotScript = "typeof window.__heronAiWebViewInputDiagnostics === 'function' ? window.__heronAiWebViewInputDiagnostics() : null";
    private const string ProbeScript = "typeof window.__heronAiWebViewInputDiagnostics === 'function' ? { version: 1 } : null";
    private static readonly Lazy<string> Script = new(() =>
    {
        using var stream = typeof(AiWebViewInputDiagnostics).Assembly.GetManifestResourceStream("HeronAI.WebViewInputDiagnostics.js")
            ?? throw new InvalidOperationException("WebView input diagnostics resource is missing.");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    });
    private readonly CoreWebView2 _browser;
    private readonly NativeWebView _view;
    private readonly ILogger _logger;
    private readonly string _viewId;
    private readonly string _kind;
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(15) };
    private Task? _preparation;
    private Task<string>? _capture;
    private string? _scriptId;
    private string? _lastNative;
    private string? _lastState;
    private string? _fault;
    private long _lastReport;
    private bool _disposed;

    internal AiWebViewInputDiagnostics(CoreWebView2 browser, NativeWebView view, ILogger logger, string viewId, string kind)
    {
        _browser = browser;
        _view = view;
        _logger = logger;
        _viewId = viewId;
        _kind = kind;
        _timer.Tick += OnTick;
    }

    // Registration precedes product navigation; a diagnostic failure cannot fail navigation.
    internal Task PrepareAsync() => _preparation ??= PrepareCoreAsync();

    private async Task PrepareCoreAsync()
    {
        try
        {
            await RegisterScriptAsync().WaitAsync(TimeSpan.FromSeconds(3));
            if (_disposed) return;
            _browser.NavigationCompleted += OnNavigationCompleted;
            _browser.ProcessFailed += OnProcessFailed;
            _timer.Start();
            _logger.LogInformation("AI WebView input diagnostic ViewId={ViewId} View={View} Stage=installed", _viewId, _kind);
        }
        catch (Exception error) { ReportFault("install-failed", error.GetType().Name); }
    }

    private async Task RegisterScriptAsync()
    {
        var id = await _browser.AddScriptToExecuteOnDocumentCreatedAsync(Script.Value);
        if (_disposed) _browser.RemoveScriptToExecuteOnDocumentCreated(id);
        else _scriptId = id;
    }

    private void OnTick(object? sender, EventArgs args) => _ = CaptureAsync();
    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs args)
    {
        if (args.IsSuccess) _ = CaptureAsync();
    }
    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs args) =>
        ReportFault("process-failed", args.ProcessFailedKind.ToString());

    private async Task CaptureAsync()
    {
        // A timed-out COM call stays single-flight until it actually completes.
        if (_disposed || _capture is { IsCompleted: false }) return;
        var native = NativeState();
        var nativeChanged = native != _lastNative;
        _lastNative = native;
        if (!_view.IsEffectivelyVisible && !nativeChanged) return;
        try
        {
            var recovering = _fault != null;
            var detailed = recovering || _logger.IsEnabled(LogLevel.Debug);
            _capture = _browser.ExecuteScriptAsync(detailed ? SnapshotScript : ProbeScript);
            var json = await _capture.WaitAsync(TimeSpan.FromSeconds(3));
            if (_disposed) return;
            if (json.Length > 32768) { ReportFault("invalid-snapshot"); return; }
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || Number(root, "version") != 1)
            {
                ReportFault("script-missing");
                return;
            }
            if (_fault != null)
            {
                _logger.LogInformation("AI WebView input diagnostic ViewId={ViewId} View={View} Stage=probe-recovered Previous={Previous}",
                    _viewId, _kind, _fault);
                _fault = null;
            }
            if (!detailed) return;
            var hit = Field(root, "hit");
            var hitSummary = hit.ValueKind == JsonValueKind.Array
                ? string.Join(" > ", hit.EnumerateArray().Take(4).Select(DescribeHit)) : "-";
            var state = $"focus={Flag(root, "focused")};hidden={Flag(root, "hidden")};selected={Flag(root, "selected")};ranges={Number(root, "ranges")};"
                + $"rootInert={Flag(root, "rootInert")};bodyInert={Flag(root, "bodyInert")};inert={Number(root, "inertCount")};modals={Number(root, "modalCount")};"
                + $"htmlPointer={Token(root, "htmlPointer", PointerValues)};bodyPointer={Token(root, "bodyPointer", PointerValues)};"
                + $"active={DescribeNode(Field(root, "active"))};hit={hitSummary}";
            var rows = Field(root, "events");
            var events = rows.ValueKind == JsonValueKind.Array
                ? string.Join(" | ", rows.EnumerateArray().Take(16).Select(row =>
                    $"{Token(row, "type", EventTypes)}@{Number(row, "at")}({Number(row, "x")},{Number(row, "y")}):{DescribeNode(Field(row, "target"))}"
                    + $":button={Number(row, "button")},trusted={Flag(row, "trusted")},prevented={Flag(row, "prevented")},bubbled={Flag(row, "bubbled")}")) : "";
            if (!recovering && !nativeChanged && state == _lastState && events.Length == 0 && _lastReport != 0
                && Stopwatch.GetElapsedTime(_lastReport) < TimeSpan.FromMinutes(1)) return;
            _lastState = state;
            _lastReport = Stopwatch.GetTimestamp();
            var counts = Field(root, "counts");
            var totals = string.Join(",", EventTypes.Select(type => $"{type}={Number(counts, type)}"));
            _logger.Log(recovering ? LogLevel.Information : LogLevel.Debug,
                "AI WebView input diagnostic ViewId={ViewId} View={View} Stage=sample PageMs={PageMs} Native={Native} Page={Page} Counts={Counts} Dropped={Dropped} Events={Events}",
                _viewId, _kind, Number(root, "at"), native, state, totals, Number(root, "dropped"), events);
        }
        catch (TimeoutException) { ReportFault("probe-timeout"); }
        catch (Exception error) { ReportFault("probe-failed", error.GetType().Name); }
    }

    private string NativeState() =>
        $"visible={_view.IsVisible};effectiveVisible={_view.IsEffectivelyVisible};enabled={_view.IsEffectivelyEnabled};"
        + $"hitTest={_view.IsHitTestVisible};focused={_view.IsFocused};windowActive={(TopLevel.GetTopLevel(_view) as Window)?.IsActive};"
        + $"size={Math.Round(_view.Bounds.Width)}x{Math.Round(_view.Bounds.Height)}";

    private void ReportFault(string stage, string? errorType = null)
    {
        if (_disposed || _fault == stage) return;
        _fault = stage;
        _logger.LogWarning("AI WebView input diagnostic ViewId={ViewId} View={View} Stage={Stage} Native={Native} ErrorType={ErrorType}",
            _viewId, _kind, stage, NativeState(), errorType);
    }

    // Treat the page as untrusted: log only bounded numbers, flags and fixed tokens.
    private static JsonElement Field(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var field) ? field : default;
    private static bool Flag(JsonElement value, string name) => Field(value, name).ValueKind == JsonValueKind.True;
    private static int Number(JsonElement value, string name) =>
        Field(value, name) is { ValueKind: JsonValueKind.Number } field && field.TryGetInt32(out var number)
            ? Math.Clamp(number, -1000000000, 1000000000) : 0;
    private static string Token(JsonElement value, string name, string[] allowed) =>
        Field(value, name) is { ValueKind: JsonValueKind.String } field && allowed.Contains(field.GetString(), StringComparer.Ordinal)
            ? field.GetString()! : "-";
    private static string DescribeNode(JsonElement value) => value.ValueKind != JsonValueKind.Object ? "-" :
        $"{Token(value, "tag", Tags)}/{Token(value, "role", Roles)}:inert={Flag(value, "inert")},disabled={Flag(value, "disabled")},editable={Flag(value, "editable")}";
    private static string DescribeHit(JsonElement value)
    {
        var rect = Field(value, "rect");
        var coordinates = rect.ValueKind == JsonValueKind.Array ? string.Join(",", rect.EnumerateArray().Take(4)
            .Select(part => part.TryGetInt32(out var number) ? Math.Clamp(number, -100000, 100000) : 0)) : "-";
        return $"{DescribeNode(value)},pointer={Token(value, "pointer", PointerValues)},rect={coordinates}";
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _timer.Stop();
        _timer.Tick -= OnTick;
        try
        {
            _browser.NavigationCompleted -= OnNavigationCompleted;
            _browser.ProcessFailed -= OnProcessFailed;
            if (_scriptId != null) _browser.RemoveScriptToExecuteOnDocumentCreated(_scriptId);
        }
        catch (Exception error) when (error is System.Runtime.InteropServices.COMException or InvalidOperationException) { }
    }
}
