using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;

namespace HeronAI.App;

public sealed class App : Application
{
    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            var options = AppOptions.Parse(desktop.Args ?? []);
            desktop.MainWindow = new AiProductWindow(options);
        }
        base.OnFrameworkInitializationCompleted();
    }
}
