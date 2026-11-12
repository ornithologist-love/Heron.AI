using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace HeronAI.Release.Protocol;

public sealed record AiRelease
{
    public const int BridgeVersion = 2;
    public const string MinimumDshHostVersion = "2.1.0";
    public static bool SupportsDshHost(string? version) => version != null
        && System.Version.TryParse(version.Split('-')[0], out var host)
        && host >= new System.Version(2, 1, 0);
    [JsonIgnore] public bool RequiresDshHost => BridgeMin >= 2 || Compare(Version, "1.1.0") >= 0;
    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower, WriteIndented = true };
    public string Product { get; init; } = "heron_ai";
    public string Version { get; init; } = "1.0.0";
    public string PackageVersion { get; init; } = "1.0.0";
    public string Channel { get; init; } = "stable";
    public string Platform { get; init; } = "win-x64";
    public int BridgeMin { get; init; } = 1;
    public int BridgeMax { get; init; } = 1;
    public string NodeVersion { get; init; } = "";
    public string Archive { get; init; } = "";
    public long Size { get; init; }
    public long UnpackedSize { get; init; }
    public string ReleaseNotes { get; init; } = "";
    public string? Signature { get; init; }
    public string? SigningCertificate { get; init; }
    public Dictionary<string, string> Files { get; init; } = new(StringComparer.Ordinal);
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string[]? Editions { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Distribution { get; init; }
    public static bool ValidEdition(string? edition) => edition is "user" or "agent" or "FL";
    public bool TargetsEdition(string? edition) => ValidEdition(edition)
        && (Editions?.Contains(edition!, StringComparer.Ordinal) ?? !RequiresDshHost);
    [JsonIgnore] public bool Compatible => Platform == "win-x64" && BridgeMin <= BridgeVersion && BridgeMax >= BridgeVersion;
    public static bool SafeName(string name) => !string.IsNullOrEmpty(name) && name.Length <= 180 && Regex.IsMatch(name, @"\A[A-Za-z0-9][A-Za-z0-9_.-]*\z") && !name.Contains("..");
    public static bool ValidProduct(string product) => product != null && Regex.IsMatch(product, @"\A[a-z][a-z0-9_]{0,63}\z");
    public static bool ValidVersion(string version)
    {
        if (string.IsNullOrEmpty(version) || !Regex.IsMatch(version, @"\A(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-preview\.[1-9][0-9]*)?\z")) return false;
        var parts = version.Split("-preview.");
        return System.Version.TryParse(parts[0], out _) && (parts.Length == 1 || long.TryParse(parts[1], out _));
    }
    public static int Compare(string left, string right)
    {
        var a = left.Split("-preview."); var b = right.Split("-preview.");
        var result = System.Version.Parse(a[0]).CompareTo(System.Version.Parse(b[0]));
        return result != 0 ? result : a.Length != b.Length ? b.Length.CompareTo(a.Length) : a.Length == 1 ? 0 : long.Parse(a[1]).CompareTo(long.Parse(b[1]));
    }
    public void Validate()
    {
        if (!ValidProduct(Product) || !ValidVersion(Version) || PackageVersion != Version ||
            Channel != (Version.Contains("-preview.") ? "preview" : "stable") || Platform != "win-x64" ||
            BridgeMin < 1 || BridgeMax < BridgeMin || !SafeName(Archive) || !Archive.EndsWith(".zip", StringComparison.Ordinal) ||
            Size <= 0 || Size > 2L * 1024 * 1024 * 1024 || UnpackedSize <= 0 || UnpackedSize > 4L * 1024 * 1024 * 1024 ||
            Files == null || !Files.ContainsKey(Archive) || !Files.ContainsKey("releases.win.json") || Files.Count != 2 ||
            Files.Any(pair => !SafeName(pair.Key) || !Regex.IsMatch(pair.Value, "\\A[0-9a-fA-F]{64}\\z"))
            || Editions != null && (Editions.Length is < 1 or > 3 || Editions.Any(e => !ValidEdition(e))
                || Editions.Distinct(StringComparer.Ordinal).Count() != Editions.Length)
            || Distribution is not (null or "ai" or "bundle")
            || BridgeMin >= BridgeVersion && (Editions == null || Distribution == null))
            throw new InvalidDataException("AI 发布清单无效");
    }
    public static AiRelease Read(string file)
    {
        if (new FileInfo(file).Length > 64 * 1024) throw new InvalidDataException("AI 发布清单过大");
        var release = JsonSerializer.Deserialize<AiRelease>(File.ReadAllText(file), Json) ?? throw new InvalidDataException("缺少 AI 清单");
        release.Validate(); return release;
    }
    public static string Hash(string file) { using var stream = File.OpenRead(file); return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant(); }
    public static void AtomicJson<T>(string file, T value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try { File.WriteAllText(temporary, JsonSerializer.Serialize(value, Json)); File.Move(temporary, file, true); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    public static IReadOnlyList<AiRelease> Catalog(string root)
    {
        if (!Directory.Exists(root)) return [];
        var releases = new List<AiRelease>();
        foreach (var dir in Directory.EnumerateDirectories(root).Where(d => ValidVersion(Path.GetFileName(d))))
        {
            try
            {
                var r = Read(Path.Combine(dir, "release.json"));
                if (r.Version == Path.GetFileName(dir) && r.Files.Keys.All(f => File.Exists(Path.Combine(dir, f))) &&
                    new FileInfo(Path.Combine(dir, r.Archive)).Length == r.Size) releases.Add(r);
            }
            catch (Exception e) when (e is IOException or JsonException or ArgumentException) { }
        }
        return releases.OrderByDescending(r => r.Version, Comparer<string>.Create(Compare)).ToArray();
    }
    public static void VerifyDirectory(string directory)
    {
        var release = Read(Path.Combine(directory, "release.json"));
        foreach (var pair in release.Files)
            if (!Hash(Path.Combine(directory, pair.Key)).Equals(pair.Value, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("发布文件哈希不符：" + pair.Key);
        if (new FileInfo(Path.Combine(directory, release.Archive)).Length != release.Size) throw new InvalidDataException("包大小不符");
    }
    public static readonly string[] Required = ["node/node.exe", "AiHost/main.mjs", "AiHost/dsh/launch.mjs", "AiHost/heron-ai/index.mjs", "AiHost/heron-ai/ui/widgets.js", "AiHost/heron-ai/acp/acp-agent.mjs", "AiHost/package-lock.json", "AiHost/dsh/web/index.html", "AiHost/heron-ai/content/templates/index.json"];
    public static void ValidatePayload(string root)
    {
        foreach (var file in Required) if (!File.Exists(Path.Combine(root, file))) throw new InvalidDataException("AI 功能包缺少 " + file);
        if (!Directory.Exists(Path.Combine(root, "AiHost", "heron-ai", "content", "skills"))) throw new InvalidDataException("AI 功能包缺少 Skills");
    }
}
