namespace HeronAI.Release.Protocol;

// Commit the manifest last so Windows directory watchers do not block publication.
public static class ReleasePublication
{
    public static void PublishLocal(string source, string parent, string version, IReadOnlyList<string> files, Action<string>? log = null)
    {
        void LogStep(string operation, Action action)
        {
            log?.Invoke($"[release-publication] 开始：{operation}");
            try
            {
                action();
                log?.Invoke($"[release-publication] 完成：{operation}");
            }
            catch (Exception error)
            {
                log?.Invoke($"[release-publication] 失败：{operation}; HResult=0x{error.HResult:X8}{Environment.NewLine}{error}");
                throw;
            }
        }

        T RetryIo<T>(string operation, Func<T> action)
        {
            for (var attempt = 1; ; attempt++)
            {
                try { return action(); }
                catch (IOException error) when (attempt < 5 && (error.HResult & 0xffff) is 5 or 32 or 33)
                {
                    var delay = TimeSpan.FromMilliseconds(250 * (1 << (attempt - 1)));
                    log?.Invoke($"[release-publication] 重试 {operation}：第 {attempt}/5 次失败，{delay.TotalMilliseconds:0}ms 后重试；{error.Message}");
                    Thread.Sleep(delay);
                }
                catch (UnauthorizedAccessException error) when (attempt < 5)
                {
                    var delay = TimeSpan.FromMilliseconds(250 * (1 << (attempt - 1)));
                    log?.Invoke($"[release-publication] 重试 {operation}：第 {attempt}/5 次失败，{delay.TotalMilliseconds:0}ms 后重试；{error.Message}");
                    Thread.Sleep(delay);
                }
            }
        }

        if (!AiRelease.SafeName(version) || files.Any(f => !AiRelease.SafeName(f))
            || !files.Contains("release.json") || files.Distinct(StringComparer.OrdinalIgnoreCase).Count() != files.Count)
            throw new InvalidDataException("不安全或缺少发布清单的发布路径");
        LogStep($"创建发布根目录 {parent}", () => Directory.CreateDirectory(parent));
        using var gate = RetryIo("取得本地发布锁", () => new FileStream(Path.Combine(parent, ".publish.lock"),
            FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None));
        var destination = Path.Combine(parent, version);
        var hashes = files.ToDictionary(file => file, file => AiRelease.Hash(Path.Combine(source, file)), StringComparer.OrdinalIgnoreCase);
        if (File.Exists(Path.Combine(destination, "release.json")))
        {
            if (Directory.GetFiles(destination).Length != files.Count || files.Any(file => !File.Exists(Path.Combine(destination, file))
                    || hashes[file] != AiRelease.Hash(Path.Combine(destination, file))))
                throw new IOException("同版本已存在不同内容，必须使用新版本：" + version);
            return;
        }
        // Catalogs require release.json. An interrupted copy is invisible and can be resumed;
        // committed versions remain immutable. No directory rename is required on Windows.
        if (Directory.Exists(destination) && (File.GetAttributes(destination) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("发布目录不能是链接：" + destination);
        LogStep($"准备未提交版本目录 {destination}", () => Directory.CreateDirectory(destination));
        if (Directory.EnumerateDirectories(destination).Any() || Directory.EnumerateFiles(destination)
                .Any(file => !hashes.ContainsKey(Path.GetFileName(file)) || (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0))
            throw new IOException("未提交版本含计划外文件：" + destination);
        var manifest = Path.Combine(parent, ".manifest-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            foreach (var file in files.Where(file => file != "release.json"))
            {
                var target = Path.Combine(destination, file);
                if (File.Exists(target) && AiRelease.Hash(target) == hashes[file]) continue;
                LogStep($"复制并校验文件 {Path.Combine(source, file)} -> {target}", () =>
                {
                    RetryIo("复制 " + file, () => { File.Copy(Path.Combine(source, file), target, true); return true; });
                    if (hashes[file] != AiRelease.Hash(target)) throw new IOException("发布文件哈希不符：" + file);
                });
            }
            File.Copy(Path.Combine(source, "release.json"), manifest);
            if (AiRelease.Hash(manifest) != hashes["release.json"]) throw new IOException("发布清单哈希不符");
            LogStep($"提交发布清单 {destination}", () => RetryIo("提交 release.json", () =>
            {
                File.Move(manifest, Path.Combine(destination, "release.json"));
                return true;
            }));
        }
        finally { if (File.Exists(manifest)) File.Delete(manifest); }
    }
}
