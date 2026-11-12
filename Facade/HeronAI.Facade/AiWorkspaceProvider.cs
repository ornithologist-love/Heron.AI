namespace HeronAI.Facade;

public sealed record AiChatTransferSession(string Provider, string SessionId, string Workspace, string Model, string Title);
public sealed record AiWorkspaceRoot(string Label, string Path);
/// <summary>One host workspace candidate pushed to the product (see HOST-INTEGRATION host control interface).</summary>
public sealed record AiWorkspaceCandidate(string Id, string Name, string Kind, string ProjectFile,
    IReadOnlyList<AiWorkspaceRoot> Roots, bool Ready, string Detail, bool AdoptSessions = false);
