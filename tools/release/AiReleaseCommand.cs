using System.Diagnostics;
using System.IO.Compression;
using System.Text.Json;
using System.Security.Cryptography.X509Certificates;
using HeronAI.Release.Protocol;

namespace HeronAI.Release;

internal static partial class AiReleaseCommand
{
    public static async Task<int> Run(string[] args)
    {
        try
        {
            if (args.Length == 0 || args[0] is "--help" or "help")
            {
                Console.WriteLine("ai-release plan|build --version <joint-version> --editions user,agent,FL [--distribution bundle] [--node-dir <verified Node directory>] [--notes <text>] [--signing-certificate <thumbprint>] [--bundle-manifest <composition.json> | --bundle-plugin <DSH plugin directories, ';' separated>]\nai-release verify --version <joint-version>\n[--output <publication directory>] [--product <stable-product-id>] [--runtime-alias <directory>]\nOutputs: dist/releases/<version>/; intermediate payload for joint releases only.");
                return 0;
            }
            var options = new Dictionary<string, string>();
            for (var i = 1; i < args.Length; i += 2)
            {
                if (i + 1 >= args.Length || args[i] is not ("--version" or "--node-dir" or "--notes" or "--signing-certificate" or "--editions" or "--distribution" or "--output" or "--bundle-plugin" or "--bundle-manifest" or "--product" or "--runtime-alias")) throw new ArgumentException("无效 ai-release 参数");
                options.Add(args[i], args[i + 1]);
            }
            var version = options.GetValueOrDefault("--version") ?? "2.3.0";
            if (!AiRelease.ValidVersion(version)) throw new ArgumentException("AI 版本必须是 X.Y.Z 或 X.Y.Z-preview.P");
            if (!AiRelease.ValidProduct(options.GetValueOrDefault("--product", "heron_ai"))) throw new ArgumentException("无效 product 标识");
            if (options.TryGetValue("--runtime-alias", out var alias) && (!AiRelease.SafeName(alias) || alias.Length > 64 || alias.Equals("heron-ai", StringComparison.OrdinalIgnoreCase)))
                throw new ArgumentException("无效 runtime-alias 目录");
            var repo = FindRepository();
            var output = Path.Combine(Path.GetFullPath(options.GetValueOrDefault("--output", Path.Combine(repo, "dist", "releases"))), version);
            if (args[0] is "plan" or "build")
            {
                var editions = options.GetValueOrDefault("--editions")?.Split(',') ?? [];
                if (editions.Length == 0 || editions.Any(e => !AiRelease.ValidEdition(e)) || editions.Distinct().Count() != editions.Length)
                    throw new ArgumentException("必须显式指定不重复的 --editions user,agent,FL 目标");
                if (options.GetValueOrDefault("--distribution", "bundle") != "bundle"
                    || Version.Parse(version.Split('-')[0]) < new Version(2, 3, 0))
                    throw new ArgumentException("仅构建 2.3.0 起的联合发布 AI 载荷，distribution 必须为 bundle。");
                options["--distribution"] = "bundle";
                if (options.ContainsKey("--bundle-manifest") && options.ContainsKey("--bundle-plugin"))
                    throw new ArgumentException("--bundle-manifest 与 --bundle-plugin 不能同时使用");
                if (options.TryGetValue("--bundle-manifest", out var manifest))
                {
                    options["--bundle-manifest"] = Path.GetFullPath(manifest);
                    if (!File.Exists(options["--bundle-manifest"])) throw new FileNotFoundException("插件组合清单不存在", manifest);
                }
            }
            if (args[0] == "plan") { Console.WriteLine($"Heron.AI {version}\nTargets: {options["--editions"]}\nDistribution: bundle\nOutput: {output}\nPayload: Node + DSH + Heron.AI runtime (win-x64)\nOptional plugins: {options.GetValueOrDefault("--bundle-manifest") ?? options.GetValueOrDefault("--bundle-plugin") ?? "none"}"); return 0; }
            if (args[0] == "build") await Build(repo, version, output, options);
            else if (args[0] == "verify") { AiRelease.VerifyDirectory(output); Console.WriteLine("AI release verified: " + output); }
            
            else throw new ArgumentException("未知 ai-release 操作");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
    private static string FindRepository()
    {
        for (var dir = new DirectoryInfo(Environment.CurrentDirectory); dir != null; dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "scripts", "build.mjs")) && Directory.Exists(Path.Combine(dir.FullName, "packages", "common", "runtime", "src"))) return dir.FullName;
        throw new DirectoryNotFoundException("请从 Heron.AI 仓库运行");
    }
    private static async Task Build(string repo, string version, string output, Dictionary<string, string> options)
    {
        if (Directory.Exists(output)) throw new IOException("版本已存在；请 verify 或使用新版本，禁止覆盖成品");
        var plugin = repo;
        using var pin = JsonDocument.Parse(File.ReadAllText(Path.Combine(plugin, "node-runtime.json")));
        var nodeDir = Path.GetFullPath(options.GetValueOrDefault("--node-dir") ?? throw new ArgumentException("build 需要 --node-dir，Node 必须匹配 node-runtime.json"));
        var node = Path.Combine(nodeDir, "node.exe");
        if (AiRelease.Hash(node) != pin.RootElement.GetProperty("sha256").GetString()) throw new InvalidDataException("Node 哈希不匹配固定版本");
        var nodeVersion = (await Execute(node, ["--version"], repo)).Trim();
        if (nodeVersion != pin.RootElement.GetProperty("version").GetString()) throw new InvalidDataException("Node 版本不匹配");
        var arch = (await Execute(node, ["-p", "process.platform + '-' + process.arch"], repo)).Trim();
        if (arch != "win32-x64") throw new InvalidDataException("需要 Windows x64 Node");
        var stage = Path.Combine(repo, ".cache", "release", version, Guid.NewGuid().ToString("N"));
        var payload = Path.Combine(stage, "app"); Directory.CreateDirectory(payload);
        // Build the same resources used by Debug/DevHost, without shipping the native plugin.
        // DSH plugins kept outside this checkout ship preinstalled (build.mjs --bundle-plugin).
        var bundled = options.TryGetValue("--bundle-manifest", out var bundleManifest)
            ? new[] { "--bundle-manifest", bundleManifest }
            : (options.GetValueOrDefault("--bundle-plugin") ?? "")
            .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .SelectMany(directory => new[] { "--bundle-plugin", Path.GetFullPath(directory) });
        await Execute(node, [Path.Combine(repo, "scripts", "build.mjs"), "--output", payload, .. bundled], repo);
        Directory.CreateDirectory(Path.Combine(payload, "node"));
        File.Copy(node, Path.Combine(payload, "node", "node.exe"), overwrite: true);
        File.Copy(Path.Combine(nodeDir, "LICENSE"), Path.Combine(payload, "node", "LICENSE"), overwrite: true);
        TrimPayload(payload, stage);
        if (options.TryGetValue("--runtime-alias", out var runtimeAlias)) AddRuntimeAlias(payload, runtimeAlias);
        AiRelease.ValidatePayload(payload);
        // Static gate before the smoke test: a module missing from the payload makes Node
        // exit with ERR_MODULE_NOT_FOUND, which the smoke test only reports as
        // "AI 冒烟未就绪". This walks the import graph and names the missing file instead.
        await VerifyPayload(node, payload, plugin);
        await Smoke(payload, stage);
        var packages = Path.Combine(stage, "packages"); Directory.CreateDirectory(packages);
        var archive = $"HeronAI-{version}-win-x64.zip";
        ZipFile.CreateFromDirectory(payload, Path.Combine(packages, archive), CompressionLevel.Optimal, false);
        var size = new FileInfo(Path.Combine(packages, archive)).Length;
        var hash = AiRelease.Hash(Path.Combine(packages, archive));
        File.WriteAllText(Path.Combine(packages, "releases.win.json"), JsonSerializer.Serialize(new { Assets = new[] { new { PackageId = "HeronAI", Version = version, Type = "Full", FileName = archive, Size = size, SHA256 = hash } } }));
        var release = new AiRelease { Product = options.GetValueOrDefault("--product", "heron_ai"), Version = version, PackageVersion = version, Channel = version.Contains("-preview.") ? "preview" : "stable", NodeVersion = nodeVersion,
            BridgeMin = AiRelease.BridgeVersion, BridgeMax = AiRelease.BridgeVersion,
            Editions = options["--editions"].Split(',').OrderBy(e => e, StringComparer.Ordinal).ToArray(),
            Distribution = "bundle",
            Archive = archive, Size = size, UnpackedSize = Directory.EnumerateFiles(payload, "*", SearchOption.AllDirectories).Sum(f => new FileInfo(f).Length),
            ReleaseNotes = options.GetValueOrDefault("--notes") ?? "", Files = new() { [archive] = hash, ["releases.win.json"] = AiRelease.Hash(Path.Combine(packages, "releases.win.json")) } };
        if (options.TryGetValue("--signing-certificate", out var thumbprint))
        {
            using var store = new X509Store(StoreName.My, StoreLocation.CurrentUser); store.Open(OpenFlags.ReadOnly);
            var certificates = store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, true);
            if (certificates.Count != 1) throw new InvalidOperationException("找不到指定的有效企业签名证书");
            release = AiReleaseSignature.Sign(release, certificates[0]);
            AiReleaseSignature.Verify(release, thumbprint);
        }
        AiRelease.AtomicJson(Path.Combine(packages, "release.json"), release);
        AiRelease.VerifyDirectory(packages);
        var local = $"HeronAI-{version}-win-x64-local.zip";
        using (var bundle = ZipFile.Open(Path.Combine(packages, local), ZipArchiveMode.Create))
            foreach (var file in release.Files.Keys.Append("release.json"))
                bundle.CreateEntryFromFile(Path.Combine(packages, file), file, CompressionLevel.NoCompression);
        ReleasePublication.PublishLocal(packages, Path.GetDirectoryName(output)!, version, release.Files.Keys.Append("release.json").Append(local).ToArray(), Console.WriteLine);
        Console.WriteLine($"AI release: {output} ({size / 1048576.0:F1} MiB)");
        Console.WriteLine("Local install package: " + Path.Combine(output, local));
    }
    private static void AddRuntimeAlias(string payload, string alias)
    {
        var source = Path.Combine(payload, "AiHost", "heron-ai");
        var target = Path.Combine(payload, "AiHost", alias);
        if (Directory.Exists(target) || File.Exists(target)) throw new IOException("Runtime alias already exists: " + alias);
        Directory.CreateDirectory(target);
        foreach (var directory in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories))
            Directory.CreateDirectory(Path.Combine(target, Path.GetRelativePath(source, directory)));
        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
            File.Copy(file, Path.Combine(target, Path.GetRelativePath(source, file)));
        Console.WriteLine("Compatibility runtime directory: " + alias);
    }

    // Runs the shared payload gate (scripts/verify-payload.mjs) against the staged release
    // payload using the pinned Node, so a packaging list that forgot a module fails the
    // release with the module name instead of shipping a package that cannot start.
    private static async Task VerifyPayload(string node, string payload, string repository)
    {
        var sourceHost = Path.Combine(repository, "packages", "common", "runtime", "src");
        var script = Path.Combine(repository, "scripts", "verify-payload.mjs");
        if (!File.Exists(script)) throw new FileNotFoundException("缺少 AI 功能包校验脚本", script);
        await Execute(node, [script, payload, "--source", sourceHost], payload);
    }
    private static async Task Smoke(string payload, string stage)
    {
        var start = new ProcessStartInfo(Path.Combine(payload, "node", "node.exe")) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = payload };
        foreach (var arg in new[] { Path.Combine(payload, "AiHost", "main.mjs"), "--token", new string('a', 48), "--static-root", Path.Combine(payload, "AiHost", "dsh", "web"), "--state-dir", Path.Combine(stage, "smoke-state"), "--local-root", Path.Combine(stage, "smoke-local") }) start.ArgumentList.Add(arg);
        using var process = Process.Start(start) ?? throw new IOException("AI 冒烟启动失败");
        var stderr = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        try
        {
            while (await process.StandardOutput.ReadLineAsync(timeout.Token) is { } line)
                if (JsonDocument.Parse(line).RootElement.TryGetProperty("event", out var e) && e.GetString() == "ready") return;
            throw new IOException("AI 冒烟未就绪：" + await stderr);
        }
        finally { process.StandardInput.Close(); if (!process.HasExited) { try { await process.WaitForExitAsync(timeout.Token); } catch { process.Kill(true); await process.WaitForExitAsync(); } } }
    }
    private static async Task<string> Execute(string program, string[] args, string directory, string? stdin = null)
    {
        var start = new ProcessStartInfo(program) { WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = stdin != null };
        foreach (var arg in args) start.ArgumentList.Add(arg);
        using var process = Process.Start(start) ?? throw new IOException("无法启动 " + program);
        var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
        if (stdin != null) { await process.StandardInput.WriteAsync(stdin); process.StandardInput.Close(); }
        await process.WaitForExitAsync(); var text = await stdout; var error = await stderr;
        if (process.ExitCode != 0) throw new IOException($"{program} failed ({process.ExitCode})\n{text}\n{error}");
        Console.Write(text); return text;
    }
}
