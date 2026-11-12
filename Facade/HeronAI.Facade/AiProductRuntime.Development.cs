using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace HeronAI.Facade;

public sealed partial class AiProductRuntime
{
    private bool _developmentHmr;
    private string DevelopmentSettingsPath => Path.Combine(StateDirectory, "development.json");
    public bool IsDebugHost { get; } = string.Equals(
        Assembly.GetEntryAssembly()?.GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration,
        "Debug", StringComparison.OrdinalIgnoreCase);
    public bool DevelopmentHmrEnabled => IsDebugHost || Volatile.Read(ref _developmentHmr);

    private bool ReadDevelopmentHmr()
    {
        try
        {
            if (!File.Exists(DevelopmentSettingsPath)) return false;
            using var document = JsonDocument.Parse(File.ReadAllText(DevelopmentSettingsPath));
            return document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty("pluginHmr", out var value) && value.ValueKind == JsonValueKind.True;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            Logger.LogWarning("AI development preference could not be read: {ErrorType}", error.GetType().Name);
            return false;
        }
    }

    public void SetDevelopmentHmrEnabled(bool enabled)
    {
        if (IsDebugHost || enabled == Volatile.Read(ref _developmentHmr)) return;
        Directory.CreateDirectory(StateDirectory);
        var temporary = DevelopmentSettingsPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temporary, JsonSerializer.Serialize(new { pluginHmr = enabled }));
            File.Move(temporary, DevelopmentSettingsPath, overwrite: true);
            Volatile.Write(ref _developmentHmr, enabled);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}
