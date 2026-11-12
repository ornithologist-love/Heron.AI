using System.Net;
using System.Net.NetworkInformation;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using Microsoft.Web.WebView2.Core;

namespace HeronAI.Facade;

/// <summary>Cookies are scoped by host, not port. Retire closed-loopback DSH authorities
/// before navigation so repeated random-port launches cannot overflow Node's HTTP headers.</summary>
[SupportedOSPlatform("windows")]
internal static class AiWebViewAuthentication
{
    private const string Prefix = "dsh-auth-";

    internal static async Task PrepareAsync(CoreWebView2 browser, Uri target, ILogger logger)
    {
        if (target.Scheme != Uri.UriSchemeHttp || target.Host != "127.0.0.1") return;
        var manager = browser.CookieManager;
        // Snapshot cookies first; a new server starting during this operation cannot
        // have a cookie in this snapshot without also appearing in the listener list.
        var cookies = await manager.GetCookiesAsync(target.GetLeftPart(UriPartial.Authority));
        HashSet<string> live;
        try
        {
            live = IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners()
                .Where(endpoint => IPAddress.IsLoopback(endpoint.Address)
                    || endpoint.Address.Equals(IPAddress.Any) || endpoint.Address.Equals(IPAddress.IPv6Any))
                .Select(endpoint => CookieName(endpoint.Port)).ToHashSet(StringComparer.Ordinal);
        }
        catch (NetworkInformationException error)
        {
            logger.LogWarning("AI WebView cookie maintenance deferred NetworkError={NetworkError}", error.ErrorCode);
            return;
        }
        live.Add(CookieName(target.Port));
        var retired = cookies.Where(cookie => cookie.Domain.TrimStart('.') == "127.0.0.1" && cookie.Path == "/"
            && cookie.Name.StartsWith(Prefix, StringComparison.Ordinal) && cookie.Name.Length == Prefix.Length + 43
            && cookie.Name.AsSpan(Prefix.Length).ContainsAnyExcept("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".AsSpan()) == false
            && !live.Contains(cookie.Name)).ToArray();
        var headerBytes = retired.Length == 0 ? 0 : cookies.Sum(cookie =>
            Encoding.UTF8.GetByteCount(cookie.Name) + Encoding.UTF8.GetByteCount(cookie.Value) + 3);
        foreach (var cookie in retired) manager.DeleteCookie(cookie);
        if (retired.Length > 0)
            logger.LogInformation("AI WebView retired closed-port auth cookies Removed={Removed} CookieHeaderBytesBefore={HeaderBytes}",
                retired.Length, headerBytes);
    }

    private static string CookieName(int port)
    {
        var authority = port == 80 ? "127.0.0.1" : $"127.0.0.1:{port}";
        return Prefix + Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(authority)))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }
}
