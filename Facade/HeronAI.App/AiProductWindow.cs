using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using HeronAI.Facade;
using System.Text.Json;

namespace HeronAI.App;

internal sealed record AppOptions(string ProductRoot, string StateDirectory, string? ServerUrl, string? ConfigurationFile)
{
    public static AppOptions Parse(string[] args, AppIdentity identity)
    {
        string? root = null, state = null, server = null, configurationFile = null;
        for (var i = 0; i < args.Length; i++)
        {
            if (i + 1 >= args.Length) throw new ArgumentException($"Missing value for {args[i]}");
            switch (args[i])
            {
                case "--product-root": root = Path.GetFullPath(args[++i]); break;
                case "--state-dir": state = Path.GetFullPath(args[++i]); break;
                case "--server-url": server = args[++i]; break;
                case "--config": configurationFile = Path.GetFullPath(args[++i]); break;
                default: throw new ArgumentException($"Unknown option {args[i]}");
            }
        }
        root ??= FindProductRoot();
        state ??= Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), identity.StateFolder);
        return new(root, state, server, configurationFile);
    }

    private static string FindProductRoot()
    {
        foreach (var seed in new[] { Environment.CurrentDirectory, AppContext.BaseDirectory })
            for (var current = new DirectoryInfo(seed); current != null; current = current.Parent)
            {
                if (File.Exists(Path.Combine(current.FullName, "AiHost", "main.mjs"))) return current.FullName;
                if (current.Name.Equals("AiHost", StringComparison.OrdinalIgnoreCase) && File.Exists(Path.Combine(current.FullName, "main.mjs")))
                    return current.Parent?.FullName ?? current.FullName;
            }
        throw new DirectoryNotFoundException("AI runtime not found. Build the product or pass --product-root.");
    }
}

internal sealed class AiProductWindow : Window
{
    private readonly string _brandName;
    private readonly AiProductRuntime _runtime;
    private readonly AiDiagnosticsController _diagnostics;
    private readonly AiProductView _mainView;
    private readonly WindowIcon _windowIcon;
    private readonly Bitmap _brandMark;
    private Window? _sessionWindow;
    private AiProductView? _sessionView;
    private Window? _diagnosticsWindow;
    private AiDiagnosticsPanel? _diagnosticsPanel;
    private bool _closing;

    public AiProductWindow(AppOptions options, AppIdentity identity)
    {
        _brandName = identity.Name;
        (_windowIcon, _brandMark) = LoadBrandAssets(identity.OpenIcon);
        Icon = _windowIcon;
        var localRoot = options.StateDirectory;
        var webViewProfile = Path.Combine(options.StateDirectory, "cache", "webview2");
        _runtime = new(new AiProductOptions(options.ProductRoot, options.StateDirectory, options.ServerUrl,
            localRoot, WebViewProfileDirectory: webViewProfile, HostIntegration: identity.HostIntegration)
            { HostSource = identity.HostSource, ConfigurationFile = options.ConfigurationFile });
        _mainView = new AiProductView(_runtime);
        _diagnostics = new AiDiagnosticsController(_runtime, async token =>
        {
            await _mainView.ReloadRuntimeAsync(token);
            if (_sessionView != null) await _sessionView.ReloadRuntimeAsync(token);
        });
        Width = 1360; Height = 900; MinWidth = 920; MinHeight = 620; Title = _brandName;
        var brand = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 8,
            Margin = new Thickness(12, 8),
            VerticalAlignment = VerticalAlignment.Center,
            Children =
            {
                new Image { Source = _brandMark, Width = 20, Height = 20, Stretch = Stretch.Uniform, VerticalAlignment = VerticalAlignment.Center },
                new TextBlock { Text = _brandName, FontSize = 14, FontWeight = FontWeight.SemiBold, VerticalAlignment = VerticalAlignment.Center },
            },
        };
        var openSession = new Button { Content = "打开单会话窗口", Margin = new Thickness(8) };
        openSession.Click += (_, _) => ShowSessionWindow();
        var openDiagnostics = new Button { Content = "AI 调试", Margin = new Thickness(0, 8, 8, 8) };
        openDiagnostics.Click += (_, _) => ShowDiagnosticsWindow();
        var toolbar = new DockPanel { LastChildFill = true, Background = new SolidColorBrush(Color.Parse("#F4F7FB")) };
        DockPanel.SetDock(brand, Dock.Left);
        DockPanel.SetDock(openSession, Dock.Right);
        DockPanel.SetDock(openDiagnostics, Dock.Right);
        toolbar.Children.Add(brand);
        toolbar.Children.Add(openSession);
        toolbar.Children.Add(openDiagnostics);
        var root = new DockPanel();
        DockPanel.SetDock(toolbar, Dock.Top);
        root.Children.Add(toolbar);
        root.Children.Add(_mainView);
        Content = root;
        Closing += OnClosing;
    }

    private static (WindowIcon, Bitmap) LoadBrandAssets(Func<Stream> openIcon)
    {
        using var stream = openIcon();
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        buffer.Position = 0;
        var windowIcon = new WindowIcon(buffer);
        buffer.Position = 0;
        var bitmap = new Bitmap(buffer);
        return (windowIcon, bitmap);
    }

    private void ShowSessionWindow()
    {
        if (_sessionWindow != null) { _sessionWindow.Show(); _sessionWindow.Activate(); return; }
        var view = new AiProductView(_runtime, "session");
        var window = new Window { Title = _brandName + " · 会话", Icon = _windowIcon, Width = 920, Height = 760, MinWidth = 680, MinHeight = 500, Content = view };
        window.Closing += (_, e) => { if (_closing) return; e.Cancel = true; window.Hide(); };
        _sessionView = view;
        _sessionWindow = window;
        window.Show(this);
        _ = SelectCurrentSessionAsync(view);
    }

    private async Task SelectCurrentSessionAsync(AiProductView view)
    {
        try
        {
            var selected = await _mainView.RequestPresentationAsync("selection");
            if (selected.TryGetProperty("sessionId", out var id) && id.GetString() is { Length: > 0 } sessionId)
                await view.OpenSessionAsync(sessionId);
        }
        catch (Exception error) { System.Diagnostics.Debug.WriteLine(error); }
    }

    private void ShowDiagnosticsWindow()
    {
        if (_diagnosticsWindow != null)
        {
            if (!_diagnosticsWindow.IsVisible) _diagnosticsWindow.Show(this);
            if (_diagnosticsWindow.WindowState == WindowState.Minimized) _diagnosticsWindow.WindowState = WindowState.Normal;
            _diagnosticsWindow.Activate();
            return;
        }
        _diagnosticsPanel = _diagnostics.CreatePanel();
        var window = new Window
        {
            Title = _diagnostics.Title, Icon = _windowIcon, Width = 1040, Height = 720, MinWidth = 720, MinHeight = 480,
            Content = _diagnosticsPanel
        };
        window.Closing += (_, e) => { if (_closing) return; e.Cancel = true; window.Hide(); };
        _diagnosticsWindow = window;
        window.Show(this);
        window.Activate();
    }

    private async void OnClosing(object? sender, WindowClosingEventArgs args)
    {
        if (_closing) return;
        args.Cancel = true;
        _closing = true;
        if (_diagnosticsWindow != null)
        {
            _diagnosticsWindow.Close();
            _diagnosticsWindow.Content = null;
            if (_diagnosticsPanel != null) _diagnostics.ReleasePanel(_diagnosticsPanel);
            _diagnosticsWindow = null;
            _diagnosticsPanel = null;
        }
        if (_sessionWindow != null)
        {
            _sessionWindow.Close();
            _sessionWindow.Content = null;
            _sessionView?.Dispose();
            _sessionWindow = null;
            _sessionView = null;
        }
        _mainView.Dispose();
        await _diagnostics.DisposeAsync();
        await _runtime.DisposeAsync();
        Close();
    }
}
