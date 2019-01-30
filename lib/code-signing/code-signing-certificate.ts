import iam = require('@aws-cdk/aws-iam');
import kms = require('@aws-cdk/aws-kms');
import ssm = require('@aws-cdk/aws-ssm');
import cdk = require('@aws-cdk/cdk');
import { ICredentialPair } from '../credential-pair';
import permissions = require('../permissions');
import { DistinguishedName } from './certificate-signing-request';
import { RsaPrivateKeySecret } from './private-key';

export { DistinguishedName } from './certificate-signing-request';

interface CodeSigningCertificateProps {
  /**
   * The number of bits to compose the modulus of the generated private key for this certificate.
   *
   * @default 2048
   */
  rsaKeySize?: number;

  /**
   * The KMS CMK to use for encrypting the Private Key secret.
   * @default A new KMS key will be allocated for you
   */
  secretEncryptionKey?: kms.IEncryptionKey;

  /**
   * The PEM-encoded certificate that was signed by the relevant authority.
   *
   * @default If a certificate is not provided, a self-signed certificate will
   * be generated and a CSR (certificate signing request) will by available in
   * the stack output.
   */
  pemCertificate?: string;

  /**
   * Whether a CSR should be generated, even if the certificate is provided.
   * This can be useful if one wants to renew a certificate that is close to
   * expiry without generating a new private key (for example, to avoid breaking
   * clients that make use of certificate pinning).
   *
   * @default false
   */
  forceCertificateSigningRequest?: boolean;

  /**
   * When enabled, the Private Key secret will have a DeletionPolicy of
   * "RETAIN", making sure the Private Key is not inadvertently destroyed.
   *
   * @default true
   */
  retainPrivateKey?: boolean;

  /**
   * The Distinguished Name for this CSR.
   */
  distinguishedName: DistinguishedName;
}

export interface ICodeSigningCertificate extends cdk.IConstruct, ICredentialPair {
  /**
   * Grant the IAM principal permissions to read the private key and
   * certificate.
   */
  grantDecrypt(principal?: iam.IPrincipal): void;
}

/**
 * A Code-Signing certificate, that will use a private key that is generated by a Lambda function. The Certificate will
 * not be usable until the ``pemCertificate`` value has been provided. A typical workflow to use this Construct would be:
 *
 * 1. Add an instance of the construct to your app, without providing the ``pemCertificate`` property
 * 2. Deploy the stack to provision a Private Key and obtain the CSR (you can surface it using a cdk.Output, for example)
 * 3. Submit the CSR to your Certificate Authority of choice.
 * 4. Populate the ``pemCertificate`` property with the PEM-encoded certificate provided by your CA of coice.
 * 5. Re-deploy the stack so make the certificate usable
 *
 * In order to renew the certificate, if you do not wish to retain the same private key (your clients do not rely on
 * public key pinning), simply add a new instance of the construct to your app and follow the process listed above. If
 * you wish to retain the private key, you can set ``forceCertificateSigningRequest`` to ``true`` in order to obtain a
 * new CSR document.
 */
export class CodeSigningCertificate extends cdk.Construct implements ICodeSigningCertificate {
  /**
   * The ARN of the AWS Secrets Manager secret that holds the private key for this CSC
   */
  public readonly privatePartSecretArn: string;

  /**
   * The ARN of the AWS SSM Parameter that holds the certificate for this CSC.
   */
  public readonly publicPartParameterArn: string;

  /**
   * The name of the AWS SSM parameter that holds the certificate for this CSC.
   */
  public readonly publicPartParameterName: string;

  /**
   * KMS key to encrypt the secret.
   */
  public readonly privatePartEncryptionKey: kms.IEncryptionKey | undefined;

  constructor(parent: cdk.Construct, id: string, props: CodeSigningCertificateProps) {
    super(parent, id);

    if (props.retainPrivateKey == null) {
      props.retainPrivateKey = true;
    }

    // The construct path of this construct, without any leading /
    const baseName = this.node.path.replace(/^\/+/, '');

    const privateKey = new RsaPrivateKeySecret(this, 'RSAPrivateKey', {
      deletionPolicy: props.retainPrivateKey ? cdk.DeletionPolicy.Retain : undefined,
      description: `The PEM-encoded private key of the x509 Code-Signing Certificate`,
      keySize: props.rsaKeySize || 2048,
      secretEncryptionKey: props.secretEncryptionKey,
      secretName: `${baseName}/RSAPrivateKey`,
    });

    this.privatePartEncryptionKey = props.secretEncryptionKey;

    this.privatePartSecretArn = privateKey.secretArn;

    let certificate = props.pemCertificate;

    if (!certificate || props.forceCertificateSigningRequest) {
      const csr = privateKey.newCertificateSigningRequest('CertificateSigningRequest',
                                                          props.distinguishedName,
                                                          'critical,digitalSignature',
                                                          'critical,codeSigning');

      new cdk.Output(this, 'CSR', {
        description: 'A PEM-encoded Certificate Signing Request for a Code-Signing Certificate',
        disableExport: true,
        value: csr.pemRequest,
      });

      if (!certificate) {
        certificate = csr.selfSignedPemCertificate;
      }
    }

    const paramName = `${baseName}/Certificate`;
    this.publicPartParameterName = `/${paramName}`;

    new ssm.CfnParameter(this, 'Resource', {
      description: `A PEM-encoded Code-Signing Certificate (private key in ${privateKey.secretArn})`,
      name: this.publicPartParameterName,
      type: 'String',
      value: certificate
    });

    this.publicPartParameterArn = cdk.Stack.find(this).formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: paramName
    });
  }

  /**
   * Grant the IAM principal permissions to read the private key and
   * certificate.
   */
  public grantDecrypt(principal?: iam.IPrincipal) {
    if (!principal) { return; }

    permissions.grantSecretRead({
      keyArn: this.privatePartEncryptionKey && this.privatePartEncryptionKey.keyArn,
      secretArn: this.privatePartSecretArn,
    }, principal);

    principal.addToPolicy(new iam.PolicyStatement()
      .addAction('ssm:GetParameter')
      .addResource(this.publicPartParameterArn));
  }
}
