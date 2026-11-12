using HeronAI.Release.Protocol;

namespace HeronAI.Release;

internal static partial class AiReleaseCommand
{
    // Only the private release stage is changed. npm's installed tree and Debug payload stay intact.
    private static void TrimPayload(string payload, string stage)
    {
        var root = Path.GetFullPath(payload).TrimEnd(Path.DirectorySeparatorChar);
        if (!root.Equals(Path.Combine(Path.GetFullPath(stage), "app"), StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("AI 裁剪必须在当前发布暂存目录执行");
        var modules = Path.Combine(root, "AiHost", "node_modules");
        var changes = new Dictionary<string, (long Bytes, int Files)>();
        string[] Files(string directory)
        {
            if (!Directory.Exists(directory)) return [];
            var relative = Path.GetRelativePath(root, Path.GetFullPath(directory));
            if (relative.StartsWith("..", StringComparison.Ordinal) || Path.IsPathFullyQualified(relative)
                || (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("AI 裁剪目录越界或包含链接：" + directory);
            foreach (var entry in Directory.EnumerateFileSystemEntries(directory, "*", SearchOption.AllDirectories))
                if ((File.GetAttributes(entry) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("AI 裁剪目录包含链接：" + entry);
            return Directory.GetFiles(directory, "*", SearchOption.AllDirectories);
        }
        void Record(string category, long bytes, int count)
        {
            var previous = changes.GetValueOrDefault(category);
            changes[category] = (previous.Bytes + bytes, previous.Files + count);
        }
        void RemoveDirectory(string directory, string category)
        {
            if (!Directory.Exists(directory)) return;
            var files = Files(directory);
            Record(category, files.Sum(file => new FileInfo(file).Length), files.Length);
            Directory.Delete(directory, true);
        }
        var zodRoots = Directory.GetFiles(modules, "package.json", SearchOption.AllDirectories)
            .Where(file => Path.GetFileName(Path.GetDirectoryName(file)) == "zod")
            .Select(file => Path.GetDirectoryName(file)!).ToArray();
        if (zodRoots.Length != 1 || !zodRoots[0].Equals(Path.Combine(modules, "zod"), StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("AI 依赖未统一为根目录的一份 Zod，请核对 lockfile 后重新发布");

        // Do not strip generic src/, types/, docs/ or assets/: DSH exports source modules,
        // and skills/plugins can read documentation and images at runtime.
        foreach (var zod in zodRoots.Where(Directory.Exists))
            foreach (var directory in Directory.GetDirectories(zod, "tests", SearchOption.AllDirectories)
                .OrderByDescending(directory => directory.Length))
                RemoveDirectory(directory, "tests-examples");
        foreach (var relative in new[] { "@mixmark-io/domino/test", "node-addon-api/test", "node-pty/examples" })
            RemoveDirectory(Path.Combine(modules, relative), "tests-examples");

        var pty = Path.Combine(modules, "node-pty", "prebuilds");
        if (Directory.Exists(pty))
        {
            foreach (var directory in Directory.GetDirectories(pty))
                if (Path.GetFileName(directory) != "win32-x64") RemoveDirectory(directory, "other-platform");
            var native = Path.Combine(pty, "win32-x64");
            foreach (var file in Files(native).Where(file => Path.GetExtension(file) == ".pdb"))
            {
                Record("native-symbols", new FileInfo(file).Length, 1);
                File.Delete(file);
            }
        }
        var report = changes.Select(pair => new { category = pair.Key, removed_bytes = pair.Value.Bytes, removed_files = pair.Value.Files }).ToArray();
        AiRelease.AtomicJson(Path.Combine(stage, "payload-trim.json"), report);
        foreach (var item in report) Console.WriteLine($"AI trim {item.category}: {item.removed_bytes / 1048576.0:F2} MiB unpacked, {item.removed_files} files");
    }
}
