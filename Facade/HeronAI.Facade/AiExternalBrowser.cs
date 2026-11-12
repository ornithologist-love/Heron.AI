using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Platform;
using Avalonia.Threading;
using Microsoft.Web.WebView2.Core;

namespace HeronAI.Facade;

/// <summary>Tries the system browser, then owns an independent WebView when its launcher fails.</summary>
internal sealed class AiExternalBrowser(string stateDirectory, string profileDirectory, Action<string, string, string, string> report)
{
    private readonly Dictionary<string, ExternalWindow> _windows = new(StringComparer.Ordinal);
    private int _generation;

    internal async Task<string> OpenAsync(Uri uri, string viewId, string view, CancellationToken token = default)
    {
        if (!uri.IsAbsoluteUri || uri.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(uri.UserInfo))
            throw new ArgumentException("External browser requires an HTTP(S) URL without user information.");
        var generation = Volatile.Read(ref _generation);
        try
        {
            Directory.CreateDirectory(stateDirectory);
            using var process = await Dispatcher.UIThread.InvokeAsync(() => Process.Start(new ProcessStartInfo(uri.AbsoluteUri)
            {
                UseShellExecute = true, WorkingDirectory = stateDirectory
            }));
            report(viewId, view, "shell-request-accepted", $"processReturned={process != null}");
            if (process == null) return "system";
            var chromium = false;
            try { chromium = process.ProcessName.ToLowerInvariant() is "chrome" or "msedge" or "brave" or "vivaldi" or "opera"; }
            catch (InvalidOperationException) { }
            report(viewId, view, "browser-process-started", $"pid={process.Id}");
            using var observation = CancellationTokenSource.CreateLinkedTokenSource(token);
            observation.CancelAfter(TimeSpan.FromSeconds(3));
            try { await process.WaitForExitAsync(observation.Token); }
            catch (OperationCanceledException) when (!token.IsCancellationRequested)
            {
                report(viewId, view, "browser-process-running", $"pid={process.Id}");
                return "system";
            }
            var exitCode = process.ExitCode;
            report(viewId, view, "browser-process-exited", $"pid={process.Id} exitCode={exitCode}");
            // Chromium also reports a successful handoff as NORMAL_EXIT_PROCESS_NOTIFIED (24).
            // https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/common/chrome_result_codes.h
            if (exitCode == 0 || (chromium && exitCode == 24)) return "system";
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception error)
        {
            report(viewId, view, "shell-request-failed", $"errorType={error.GetType().Name} hresult={error.HResult}");
        }
        token.ThrowIfCancellationRequested();
        return await Dispatcher.UIThread.InvokeAsync(() =>
        {
            if (generation != Volatile.Read(ref _generation)) throw new OperationCanceledException();
            ShowWebView(uri, viewId, view);
            return "webview";
        });
    }

    private void ShowWebView(Uri uri, string viewId, string view)
    {
        if (_windows.TryGetValue(uri.AbsoluteUri, out var existing))
        {
            if (existing.WindowState == WindowState.Minimized) existing.WindowState = WindowState.Normal;
            existing.Activate();
            report(viewId, view, "webview-fallback-activated", "");
            return;
        }
        var window = new ExternalWindow(uri, profileDirectory, next => ShowWebView(next, viewId, view),
            error => report(viewId, view, "webview-close-hook-unavailable", $"errorType={error.GetType().Name}"));
        _windows.Add(uri.AbsoluteUri, window);
        window.Closed += (_, _) => _windows.Remove(uri.AbsoluteUri);
        try
        {
            if ((Application.Current?.ApplicationLifetime as IClassicDesktopStyleApplicationLifetime)?.MainWindow is { } owner)
                window.Show(owner);
            else window.Show();
            report(viewId, view, "webview-fallback-opened", $"scheme={uri.Scheme}");
        }
        catch
        {
            _windows.Remove(uri.AbsoluteUri);
            window.Close();
            throw;
        }
    }

    internal async Task CloseAsync()
    {
        Interlocked.Increment(ref _generation);
        if (Application.Current == null) return;
        await Dispatcher.UIThread.InvokeAsync(() =>
        {
            foreach (var window in _windows.Values.ToArray()) window.Close();
        });
    }

    private sealed class ExternalWindow : Window
    {
        private readonly NativeWebView _browser = new();
        private readonly Action<Exception> _reportError;
        private CoreWebView2? _windowsBrowser;

        internal ExternalWindow(Uri uri, string profile, Action<Uri> openPopup, Action<Exception> reportError)
        {
            _reportError = reportError;
            Title = "外部网页 · " + uri.Host;
            Width = 1100; Height = 800; MinWidth = 480; MinHeight = 360;
            WindowStartupLocation = WindowStartupLocation.CenterOwner;
            Content = _browser;
            _browser.EnvironmentRequested += (_, args) =>
            {
                if (args is not WindowsWebView2EnvironmentRequestedEventArgs windows) return;
                Directory.CreateDirectory(profile);
                windows.UserDataFolder = profile;
            };
            _browser.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                if (args.Request is { IsAbsoluteUri: true, Scheme: "http" or "https" } target && string.IsNullOrEmpty(target.UserInfo))
                    openPopup(target);
            };
            _browser.AdapterCreated += (_, _) => { if (OperatingSystem.IsWindows()) AttachWindowsBrowser(); };
            _browser.AdapterDestroyed += (_, _) => DetachWindowsBrowser();
            Opened += (_, _) => _browser.Source = uri;
            Closed += (_, _) => { DetachWindowsBrowser(); Content = null; };
        }

        [SupportedOSPlatform("windows")]
        private void AttachWindowsBrowser()
        {
            if (_browser.TryGetPlatformHandle() is not IWindowsWebView2PlatformHandle handle) return;
            var pointer = handle.CoreWebView2;
            try
            {
                _windowsBrowser = CoreWebView2.CreateFromComICoreWebView2(pointer);
                _windowsBrowser.WindowCloseRequested += CloseRequested;
            }
            catch (Exception error) when (error is COMException or InvalidOperationException) { _reportError(error); }
            finally { if (pointer != IntPtr.Zero) Marshal.Release(pointer); }
        }

        private void CloseRequested(object? sender, object args) => Close();

        private void DetachWindowsBrowser()
        {
            var browser = _windowsBrowser;
            _windowsBrowser = null;
            if (browser == null) return;
            try { browser.WindowCloseRequested -= CloseRequested; }
            catch (Exception error) when (error is COMException or InvalidOperationException) { }
        }
    }
}
