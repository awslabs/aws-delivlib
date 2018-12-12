import cfn = require('@aws-cdk/aws-cloudformation');
import lambda = require('@aws-cdk/aws-lambda');
import cdk = require('@aws-cdk/cdk');
import fs = require('fs');
import path = require('path');
import { RsaPrivateKeySecret } from './private-key';

export interface CertificateSigningRequestProps {
  /**
   * The RSA Private Key to use for this CSR.
   */
  privateKey: RsaPrivateKeySecret;
  /**
   * The Distinguished Name for this CSR.
   */
  dn: DistinguishedName;
  /**
   * The key usage requests for this CSR.
   *
   * @example critical,digitalSignature
   */
  keyUsage: string;
  /**
   * The extended key usage requests for this CSR.
   *
   * @example critical,codeSigning
   */
  extendedKeyUsage?: string;
}

/**
 * Creates a Certificate Signing Request (CSR), which will allow a Certificate Authority to provide a signed certificate
 * that uses the specified RSA Private Key. A CSR document can usually be shared publicly, however it must be noted that
 * the information provided in the ``dn`` fields, information about the public key and the intended ley usage will be
 * readable by anyone who can access the CSR.
 *
 * @see https://www.openssl.org/docs/manmaster/man1/req.html
 */
export class CertificateSigningRequest extends cdk.Construct {
  /**
   * The PEM-encoded CSR document.
   */
  public readonly pemRequest: string;

  public readonly selfSignedPemCertificate: string;

  constructor(parent: cdk.Construct, id: string, props: CertificateSigningRequestProps) {
    super(parent, id);

    const customResource = new lambda.SingletonFunction(this, 'ResourceHandler', {
      uuid: '541F6782-6DCF-49A7-8C5A-67715ADD9E4C',
      runtime: lambda.Runtime.Python36,
      handler: 'index.main',
      code: new lambda.InlineCode(
        fs.readFileSync(path.join(__dirname, 'certificate-signing-request.py'))
          .toString('utf8')
          // Remove blank and comment-only lines, to shrink code length
          .replace(/^[ \t]*(#[^\n]*)?\n/gm, '')
      ),
      timeout: 300,
    });

    const csr = new cfn.CustomResource(this, 'Resource', {
      lambdaProvider: customResource,
      resourceType: 'Custom::CertificateSigningRequest',
      properties: {
        // Private key
        privateKeySecretId: props.privateKey.secretArn,
        privateKeySecretVersion: props.privateKey.secretVersion,
        // Distinguished name
        dnCommonName: props.dn.commonName,
        dnCountry: props.dn.country,
        dnStateOrProvince: props.dn.stateOrProvince,
        dnLocality: props.dn.locality,
        dnOrganizationName: props.dn.organizationName,
        dnOrganizationalUnitName: props.dn.organizationalUnitName,
        dnEmailAddress: props.dn.emailAddress,
        // Key Usage
        extendedKeyUsage: props.extendedKeyUsage || '',
        keyUsage: props.keyUsage,
      }
    });
    if (customResource.role) {
      // Make sure the permissions are all good before proceeding
      csr.addDependency(customResource.role);
      csr.addDependency(props.privateKey.grantGetSecretValue(customResource.role));
    }

    this.pemRequest = csr.getAtt('CSR').toString();
    this.selfSignedPemCertificate = csr.getAtt('SelfSignedCertificate').toString();
  }
}

/**
 * Fields that compose the distinguished name of a certificate
 */
export interface DistinguishedName {
  /** The Common Name (CN) */
  commonName: string;
  /** The email address (emailAddress) */
  emailAddress: string;

  /** The Country (C) */
  country: string;
  /** The State or Province (ST) */
  stateOrProvince: string;
  /** The locality (L) */
  locality: string;

  /** The organization name (O) */
  organizationName: string;
  /** The organizational unit name (OU) */
  organizationalUnitName: string;
}
