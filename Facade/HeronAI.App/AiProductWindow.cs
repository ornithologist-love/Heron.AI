using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;
using HeronAI.Facade;
using System.Text.Json;

namespace HeronAI.App;

internal sealed record AppOptions(string ProductRoot, string StateDirectory, string? ServerUrl, string? ConfigurationFile)
{
    public static AppOptions Parse(string[] args)
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
        state ??= Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".heron-ai");
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
        throw new DirectoryNotFoundException("HeronAI runtime not found. Run npm run build or pass --product-root.");
    }
}

internal sealed class AiProductWindow : Window
{
    private readonly AiProductRuntime _runtime;
    private readonly AiProductView _mainView;
    private Window? _sessionWindow;
    private AiProductView? _sessionView;
    private bool _closing;

    public AiProductWindow(AppOptions options)
    {
        var localRoot = options.StateDirectory;
        var webViewProfile = Path.Combine(options.StateDirectory, "cache", "webview2");
        _runtime = new(new AiProductOptions(options.ProductRoot, options.StateDirectory, options.ServerUrl,
            localRoot, WebViewProfileDirectory: webViewProfile)
            { HostSource = "heron-ai-app", ConfigurationFile = options.ConfigurationFile });
        _mainView = new AiProductView(_runtime);
        Width = 1360; Height = 900; MinWidth = 920; MinHeight = 620; Title = "Heron.AI";
        var openSession = new Button { Content = "打开单会话窗口", Margin = new Thickness(8) };
        openSession.Click += (_, _) => ShowSessionWindow();
        var toolbar = new DockPanel { LastChildFill = true, Background = new SolidColorBrush(Color.Parse("#F4F7FB")) };
        DockPanel.SetDock(openSession, Dock.Right);
        toolbar.Children.Add(openSession);
        var root = new DockPanel();
        DockPanel.SetDock(toolbar, Dock.Top);
        root.Children.Add(toolbar);
        root.Children.Add(_mainView);
        Content = root;
        Closing += OnClosing;
    }

    private void ShowSessionWindow()
    {
        if (_sessionWindow != null) { _sessionWindow.Show(); _sessionWindow.Activate(); return; }
        var view = new AiProductView(_runtime, "session");
        var window = new Window { Title = "Heron.AI · 会话", Width = 920, Height = 760, MinWidth = 680, MinHeight = 500, Content = view };
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

    private async void OnClosing(object? sender, WindowClosingEventArgs args)
    {
        if (_closing) return;
        args.Cancel = true;
        _closing = true;
        if (_sessionWindow != null)
        {
            _sessionWindow.Close();
            _sessionWindow.Content = null;
            _sessionView?.Dispose();
            _sessionWindow = null;
            _sessionView = null;
        }
        _mainView.Dispose();
        await _runtime.DisposeAsync();
        Close();
    }
}
