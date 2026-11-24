namespace HeronAI.Facade;

/// <summary>Thread-safe line buffer bounded by both line count and total characters.</summary>
internal sealed class AiDiagnosticsLogBuffer
{
    private readonly object _gate = new();
    private readonly Queue<string> _lines = new();
    private readonly int _maxCharacters;
    private readonly int _maxLines;
    private int _characters;

    public AiDiagnosticsLogBuffer(int maxLines, int maxCharacters)
    {
        if (maxLines <= 0) throw new ArgumentOutOfRangeException(nameof(maxLines));
        if (maxCharacters <= 0) throw new ArgumentOutOfRangeException(nameof(maxCharacters));
        _maxLines = maxLines;
        _maxCharacters = maxCharacters;
    }

    public void Append(string? line)
    {
        line ??= "";
        if (line.Length > _maxCharacters)
            line = line[^_maxCharacters..];
        lock (_gate)
        {
            _lines.Enqueue(line);
            _characters += Cost(line);
            while (_lines.Count > _maxLines || (_characters > _maxCharacters && _lines.Count > 1))
            {
                var removed = _lines.Dequeue();
                _characters -= Cost(removed);
            }
        }
    }

    public string GetTailText(int maxLines, int maxCharacters)
    {
        if (maxLines <= 0) throw new ArgumentOutOfRangeException(nameof(maxLines));
        if (maxCharacters <= 0) throw new ArgumentOutOfRangeException(nameof(maxCharacters));

        lock (_gate)
        {
            if (_lines.Count == 0)
                return "";

            var lines = _lines.ToArray();
            var minimumIndex = Math.Max(0, lines.Length - maxLines);
            var first = lines.Length;
            var characters = 0;
            for (var i = lines.Length - 1; i >= minimumIndex; i--)
            {
                var added = lines[i].Length + (i == lines.Length - 1 ? 0 : Environment.NewLine.Length);
                if (characters + added > maxCharacters)
                {
                    first = i + 1;
                    break;
                }

                characters += added;
                first = i;
            }

            if (first >= lines.Length)
                return lines[^1].Length <= maxCharacters ? lines[^1] : lines[^1][^maxCharacters..];
            return string.Join(Environment.NewLine, lines, first, lines.Length - first);
        }
    }

    public void Clear()
    {
        lock (_gate)
        {
            _lines.Clear();
            _characters = 0;
        }
    }

    private static int Cost(string line) => line.Length + Environment.NewLine.Length;
}
