using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows.Input;

namespace HeronAI.Facade;

internal sealed class AiDiagnosticsPanelModel : INotifyPropertyChanged
{
    private readonly AiDiagnosticsController _controller;
    private readonly RelayActionCommand _restartCommand;
    private readonly RelayActionCommand _hotReloadCommand;
    private readonly RelayActionCommand _clearCommand;

    private long _revision = -1;
    private bool _synchronizing;
    private string _status = "AI 未运行";
    private string _message = "";
    private string _logText = "";
    private bool _followOutput = true;
    private bool _developmentHmrEnabled;
    private bool _canConfigureDevelopmentHmr;
    private string _developmentHmrHint = "";
    private bool _canOperate = true;

    public AiDiagnosticsPanelModel(AiDiagnosticsController controller)
    {
        _controller = controller;
        _restartCommand = new RelayActionCommand(() => _controller.RunAsync(restart: true), () => CanOperate);
        _hotReloadCommand = new RelayActionCommand(() => _controller.RunAsync(restart: false), () => CanOperate);
        _clearCommand = new RelayActionCommand(() => { _controller.Clear(); return Task.CompletedTask; }, static () => true);
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    public string Status { get => _status; private set => SetField(ref _status, value); }
    public string Message { get => _message; private set => SetField(ref _message, value); }
    public string LogText { get => _logText; private set => SetField(ref _logText, value); }
    public bool FollowOutput { get => _followOutput; set => SetField(ref _followOutput, value); }
    public bool CanConfigureDevelopmentHmr { get => _canConfigureDevelopmentHmr; private set => SetField(ref _canConfigureDevelopmentHmr, value); }
    public string DevelopmentHmrHint { get => _developmentHmrHint; private set => SetField(ref _developmentHmrHint, value); }

    public bool DevelopmentHmrEnabled
    {
        get => _developmentHmrEnabled;
        set
        {
            if (SetField(ref _developmentHmrEnabled, value) && !_synchronizing)
                _controller.SetDevelopmentHmrEnabled(value);
        }
    }

    public bool CanOperate
    {
        get => _canOperate;
        private set
        {
            if (SetField(ref _canOperate, value))
            {
                _restartCommand.NotifyCanExecuteChanged();
                _hotReloadCommand.NotifyCanExecuteChanged();
            }
        }
    }

    public ICommand RestartCommand => _restartCommand;
    public ICommand HotReloadCommand => _hotReloadCommand;
    public ICommand ClearCommand => _clearCommand;

    internal bool Refresh()
    {
        Status = _controller.Status;
        Message = _controller.Message;
        CanOperate = _controller.CanOperate;
        _synchronizing = true;
        try { DevelopmentHmrEnabled = _controller.DevelopmentHmrEnabled; }
        finally { _synchronizing = false; }
        CanConfigureDevelopmentHmr = _controller.CanConfigureDevelopmentHmr;
        DevelopmentHmrHint = _controller.DevelopmentHmrHint;
        var revision = _controller.Revision;
        if (_revision == revision) return false;
        _revision = revision;
        LogText = _controller.LogText;
        return true;
    }

    private bool SetField<T>(ref T field, T value, [CallerMemberName] string? propertyName = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return false;
        field = value;
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
        return true;
    }

    private sealed class RelayActionCommand(Func<Task> execute, Func<bool> canExecute) : ICommand
    {
        public event EventHandler? CanExecuteChanged;
        public bool CanExecute(object? parameter) => canExecute();
        public async void Execute(object? parameter)
        {
            if (CanExecute(parameter)) await execute();
        }
        public void NotifyCanExecuteChanged() => CanExecuteChanged?.Invoke(this, EventArgs.Empty);
    }
}
