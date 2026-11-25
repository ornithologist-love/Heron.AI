using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Avalonia.Platform;

namespace HeronAI.App;

public sealed record AppIdentity(string Name, string StateFolder, string HostSource, Func<Stream> OpenIcon,
    string? HostIntegration = null);

public sealed class App : Application
{
    private readonly AppIdentity _identity;

    public App() : this(new AppIdentity("Heron.AI", ".heron-ai", "heron-ai-app",
        () => AssetLoader.Open(new Uri("avares://HeronAI.App/Assets/heron-64.png")))) {}

    public App(AppIdentity identity) => _identity = identity;

    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            var options = AppOptions.Parse(desktop.Args ?? [], _identity);
            desktop.MainWindow = new AiProductWindow(options, _identity);
        }
        base.OnFrameworkInitializationCompleted();
    }
}
