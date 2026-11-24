using Avalonia;
using Avalonia.Controls;
using Avalonia.Threading;

namespace HeronAI.Facade;

/// <summary>Live diagnostics view for restarting, hot-reloading, toggling HMR, and tailing runtime logs.</summary>
public sealed partial class AiDiagnosticsPanel : UserControl, IDisposable
{
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromMilliseconds(250) };
    private readonly AiDiagnosticsPanelModel _model;
    private bool _disposed;
    private TopLevel? _topLevel;

    public AiDiagnosticsPanel()
    {
        InitializeComponent();
        _model = null!;
    }

    public AiDiagnosticsPanel(AiDiagnosticsController controller)
    {
        ArgumentNullException.ThrowIfNull(controller);
        InitializeComponent();
        DataContext = _model = new AiDiagnosticsPanelModel(controller);
        _timer.Tick += OnTick;
        // Hidden diagnostic windows retain collection, but do not lay out new log snapshots.
        AttachedToVisualTree += (_, _) =>
        {
            _topLevel = TopLevel.GetTopLevel(this);
            if (_topLevel != null) _topLevel.PropertyChanged += OnVisibilityChanged;
            UpdateTimer();
        };
        DetachedFromVisualTree += (_, _) => { DetachWindow(); _timer.Stop(); };
    }

    private void OnVisibilityChanged(object? sender, AvaloniaPropertyChangedEventArgs e)
    {
        if (e.Property == IsVisibleProperty) UpdateTimer();
    }

    private void DetachWindow()
    {
        if (_topLevel != null) _topLevel.PropertyChanged -= OnVisibilityChanged;
        _topLevel = null;
    }

    private void UpdateTimer()
    {
        if (_disposed || !IsEffectivelyVisible || VisualRoot == null) { _timer.Stop(); return; }
        OnTick(null, EventArgs.Empty);
        _timer.Start();
    }

    private void OnTick(object? sender, EventArgs e)
    {
        if (!_model.Refresh() || !_model.FollowOutput) return;
        Dispatcher.UIThread.Post(() =>
        {
            if (!_disposed && IsEffectivelyVisible)
                this.FindControl<ScrollViewer>("LogScroll")?.ScrollToEnd();
        }, DispatcherPriority.Background);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _timer.Stop();
        _timer.Tick -= OnTick;
        DetachWindow();
        DataContext = null;
    }
}
