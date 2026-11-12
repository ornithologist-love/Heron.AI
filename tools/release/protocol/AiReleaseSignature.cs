using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

namespace HeronAI.Release.Protocol;

public static class AiReleaseSignature
{
    private static byte[] Data(AiRelease release) => Encoding.UTF8.GetBytes(JsonSerializer.Serialize(release with { Signature = null, SigningCertificate = null }, AiRelease.Json));
    public static AiRelease Sign(AiRelease release, X509Certificate2 certificate)
    {
        using var rsa = certificate.GetRSAPrivateKey() ?? throw new InvalidOperationException("AI 发布签名需要可访问的 RSA 企业证书私钥");
        return release with { SigningCertificate = Convert.ToBase64String(certificate.RawData), Signature = Convert.ToBase64String(rsa.SignData(Data(release), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)) };
    }
    public static void Verify(AiRelease release, string trustedThumbprint)
    {
        if (string.IsNullOrEmpty(release.Signature) || string.IsNullOrEmpty(release.SigningCertificate)) throw new InvalidDataException("AI 发布包缺少企业签名");
        using var certificate = new X509Certificate2(Convert.FromBase64String(release.SigningCertificate));
        if (!certificate.Thumbprint.Equals(trustedThumbprint, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("AI 发布签名与 HERON_AI 发布者不匹配");
        using var rsa = certificate.GetRSAPublicKey();
        if (rsa == null || !rsa.VerifyData(Data(release), Convert.FromBase64String(release.Signature), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)) throw new InvalidDataException("AI 发布签名验证失败");
    }
}
