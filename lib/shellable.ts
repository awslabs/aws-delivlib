import * as fs from 'fs';
import * as path from 'path';
import {
  Construct, Duration,
  aws_cloudwatch as cloudwatch, aws_codebuild as cbuild,
  aws_codepipeline as cpipeline, aws_codepipeline_actions as cpipeline_actions,
  aws_iam as iam, aws_s3_assets as assets, aws_secretsmanager, aws_ssm,
} from 'monocdk';
import { BuildSpec } from './build-spec';
import { renderEnvironmentVariables } from './util';

const S3_BUCKET_ENV = 'SCRIPT_S3_BUCKET';
const S3_KEY_ENV = 'SCRIPT_S3_KEY';

export interface ShellableOptions {

  /**
   * Source for the CodeBuild project
   *
   * @default no source
   */
  source?: cbuild.ISource;

  /**
   * What platform to us to run the scripts on
   *
   * @default ShellPlatform.LinuxUbuntu
   */
  platform?: ShellPlatform;

  /**
   * Additional environment variables to set.
   *
   * @default No additional environment variables
   */
  environment?: { [key: string]: string };

  /**
   * Environment variables with secrets manager values.
   *
   * @default no additional environment variables
   */
  environmentSecrets?: { [key: string]: string };

  /**
   * Environment variables with SSM parameter values.
   *
   * @default no additional environment variables
   */
  environmentParameters?: { [key: string]: string };

  /**
   * The compute type to use for the build container.
   *
   * Note that not all combinations are available. For example,
   * Windows images cannot be run on ComputeType.Small.
   *
   * @default ComputeType.Medium
   */
  computeType?: cbuild.ComputeType;

  /**
   * Indicates how the project builds Docker images. Specify true to enable
   * running the Docker daemon inside a Docker container. This value must be
   * set to true only if this build project will be used to build Docker
   * images, and the specified build environment image is not one provided by
   * AWS CodeBuild with Docker support. Otherwise, all associated builds that
   * attempt to interact with the Docker daemon will fail.
   *
   * @default false
   */
  privileged?: boolean;

  /**
   * The name for the build project.
   *
   * @default a name is generated by CloudFormation.
   */
  buildProjectName?: string;

  /**
   * Indicates if Regional AWS STS endpoints should be used instead
   * of the global endpoint. Specify true to use Regional AWS STS endpoints.
   *
   * @default false
   */
  useRegionalStsEndpoints?: boolean;

  /**
   * Can be used to run this build using a specific IAM role. This can be used,
   * for example, to execute in the context of another account (e.g. to run
   * tests in isolation).
   */
  assumeRole?: AssumeRole;

  /**
   * Additional buildspec (for artifacts etc.)
   *
   * @default No additional buildspec
   */
  buildSpec?: BuildSpec;

  /**
   * The timeout of the build.
   *
   * @default the CodeBuild default (1 hour)
   */
  timeout?: Duration;

  /**
   * Alarm period.
   *
   * @default 300 seconds (5 minutes)
   */
  alarmPeriod?: Duration;

  /**
   * Alarm threshold.
   * @default 1
   */
  alarmThreshold?: number;

  /**
   * Alarm evaluation periods.
   * @default 1
   */
  alarmEvaluationPeriods?: number;

  secondaryArtifactNames?: string[];
}

/**
 * Properties used to create a Shellable
 */
export interface ShellableProps extends ShellableOptions {
  /**
   * Directory with the scripts.
   *
   * The whole directory will be uploaded.
   */
  scriptDirectory: string;

  /**
   * Filename of the initial script to start, relative to scriptDirectory.
   */
  entrypoint: string;
}

export interface AssumeRole {
  /**
   * The Amazon Resource Name (ARN) of the role to assume.
   */
  roleArn: string;

  /**
   * An identifier for the assumed role session.
   *
   * Use  the  role  session name to uniquely identify a session when the same
   * role is assumed by different principals or for different reasons. In
   * cross-account scenarios, the role session name is visible to, and can be
   * logged by the account that owns the role.  The role session name is also
   * used in the ARN of the assumed role principal. This means that subsequent
   * cross-account API requests using the tem- porary security credentials will
   * expose the role session name to the external account in their CloudTrail
   * logs.
   *
   * The regex used to validate this parameter is a string of characters
   * consisting  of upper- and lower-case alphanumeric characters with no
   * spaces. You can also include underscores or any of the following
   * characters: =,.@-
   */
  sessionName: string;

  /**
   * A  unique  identifier  that  is  used by third parties when assuming roles
   * in their customers' accounts. For each  role  that  the  third party can
   * assume, they should instruct their customers to ensure the role's trust
   * policy checks for the external ID that the third  party generated.  Each
   * time the third party assumes the role, they should pass the customer's
   * external ID. The external ID is useful in  order to  help  third  parties
   * bind a role to the customer who created it. For more information about the
   * external ID, see How to Use an Exter- nal  ID  When Granting Access to Your
   * AWS Resources to a Third Party in the IAM User Guide .
   *
   * This parameter must be a string of characters consisting  of upper- and
   * lower-case alphanumeric characters with no spaces. You can also include
   * underscores or  any  of  the  following characters: =,.@:/-
   */
  externalId?: string;

  /**
   * When a profie name is configured, an assumed role configuration will be created
   * in the shared aws configuration file (~/.aws/config). This is in contrary of simply invoking
   * an `sts assume-role` command that creates a session with a fixed expiry date.
   *
   * Using a profile will delegate credential refreshing to the SDK/CLI.
   * This is needed to support long running sessions that needs sessions that are longer than
   * the session duration that can be configured with a `sts assume-role`.
   *
   * The application code will access to this profile in the `AWS_PROFILE` env variable.
   *
   * Only relevant if `refresh` is specified.
   *
   * @see https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html
   *
   * @default 'long-running-profile'
   */
  profileName?: string;

  /**
   * Specify this if you have a long running execution that needs long running sessions.
   * This will create a profile and use it to delegate credential refreshing to the SDK/CLI
   *
   * @default false
   */
  refresh?: boolean;

}

/**
 * A CodeBuild project that runs arbitrary scripts.
 *
 * The scripts to be run are specified by supplying a directory.
 * All files in the directory are uploaded, then the script designated
 * as the entry point is started.
 *
 * The script is executed in the directory where the build project's
 * input is stored. The directory where the script files are stored
 * is in the $SCRIPT_DIR environment variable.
 *
 * Supports both Windows and Linux computes.
 */
export class Shellable extends Construct {
  public readonly project: cbuild.Project;
  public readonly role: iam.IRole;

  /**
   * CloudWatch alarm that will be triggered if this action fails.
   */
  public readonly alarm: cloudwatch.Alarm;

  private readonly platform: ShellPlatform;
  private readonly buildSpec: BuildSpec;

  private readonly outputArtifactName: string;

  constructor(parent: Construct, id: string, props: ShellableProps) {
    super(parent, id);

    this.platform = props.platform || ShellPlatform.LinuxUbuntu;

    const entrypoint = path.join(props.scriptDirectory, props.entrypoint);
    if (!fs.existsSync(entrypoint)) {
      throw new Error(`Cannot find test entrypoint: ${entrypoint}`);
    }

    const asset = new assets.Asset(this, 'ScriptDirectory', {
      path: props.scriptDirectory,
    });

    this.outputArtifactName = `Artifact_${this.node.uniqueId}`;
    if (this.outputArtifactName.length > 100) {
      throw new Error(`Whoops, too long: ${this.outputArtifactName}`);
    }

    this.buildSpec = BuildSpec.simple({
      preBuild: this.platform.prebuildCommands(props.assumeRole, props.useRegionalStsEndpoints),
      build: this.platform.buildCommands(props.entrypoint),
    }).merge(props.buildSpec || BuildSpec.empty());

    this.project = new cbuild.Project(this, 'Resource', {
      projectName: props.buildProjectName,
      source: props.source,
      environment: {
        buildImage: this.platform.buildImage,
        computeType: props.computeType || cbuild.ComputeType.MEDIUM,
        privileged: props.privileged,
      },
      environmentVariables: {
        [S3_BUCKET_ENV]: { value: asset.s3BucketName },
        [S3_KEY_ENV]: { value: asset.s3ObjectKey },
        ...renderEnvironmentVariables(props.environment),
        ...renderEnvironmentVariables(props.environmentSecrets, cbuild.BuildEnvironmentVariableType.SECRETS_MANAGER),
        ...renderEnvironmentVariables(props.environmentParameters, cbuild.BuildEnvironmentVariableType.PARAMETER_STORE),
      },
      timeout: props.timeout,
      buildSpec: cbuild.BuildSpec.fromObject(this.buildSpec.render({ primaryArtifactName: this.outputArtifactName })),
    });

    this.role = this.project.role!; // not undefined, as it's a new Project
    asset.grantRead(this.role);

    // Grant read access to secrets
    Object.entries(props.environmentSecrets ?? {}).forEach(([name, secretArn]) => {
      const secret = aws_secretsmanager.Secret.fromSecretArn(this, `${name}Secret`, secretArn);
      secret.grantRead(this.role);
    });

    // Grant read access to parameters
    Object.entries(props.environmentParameters ?? {}).forEach(([name, parameterName]) => {
      const parameter = aws_ssm.StringParameter.fromStringParameterName(this, `${name}Parameter`, parameterName);
      parameter.grantRead(this.role);
    });

    if (props.assumeRole) {
      this.role.addToPolicy(new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [props.assumeRole.roleArn],
      }));
    }

    this.alarm = new cloudwatch.Alarm(this, 'Alarm', {
      metric: this.project.metricFailedBuilds({ period: props.alarmPeriod || Duration.seconds(300) }),
      threshold: props.alarmThreshold || 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: props.alarmEvaluationPeriods || 1,
      treatMissingData: cloudwatch.TreatMissingData.IGNORE,
    });
  }

  public addToPipeline(stage: cpipeline.IStage, name: string, inputArtifact: cpipeline.Artifact, runOrder?: number):
  cpipeline_actions.CodeBuildAction {
    const codeBuildAction = new cpipeline_actions.CodeBuildAction({
      actionName: name,
      project: this.project,
      runOrder,
      input: inputArtifact,
      outputs: [new cpipeline.Artifact(this.outputArtifactName)].concat(
        this.buildSpec.additionalArtifactNames.map(artifactName => new cpipeline.Artifact(artifactName))),
    });
    stage.addAction(codeBuildAction);
    return codeBuildAction;
  }
}

/**
 * Platform archetype
 */
export enum PlatformType {
  Linux = 'Linux',
  Windows = 'Windows'
}

/**
 * The platform type to run the scripts on
 */
export abstract class ShellPlatform {
  /**
   * Return a default Ubuntu Linux platform
   */
  public static get LinuxUbuntu(): ShellPlatform {
    // Cannot be static member because of initialization order
    return new LinuxPlatform(cbuild.LinuxBuildImage.STANDARD_4_0);
  }

  /**
   * Return a default Windows platform
   */
  public static get Windows(): ShellPlatform {
    // Cannot be static member because of initialization order
    return new WindowsPlatform(cbuild.WindowsBuildImage.WIN_SERVER_CORE_2019_BASE);
  }

  constructor(public readonly buildImage: cbuild.IBuildImage) {
  }

  /**
   * Return commands to download the script bundle
   */
  public abstract prebuildCommands(assumeRole?: AssumeRole, useRegionalStsEndpoints?: boolean): string[];

  /**
   * Return commands to start the entrypoint script
   */
  public abstract buildCommands(entrypoint: string): string[];

  /**
   * Type of platform
   */
  public abstract get platformType(): PlatformType;
}

/**
 * A Linux Platform
 */
export class LinuxPlatform extends ShellPlatform {
  public readonly platformType = PlatformType.Linux;

  public prebuildCommands(assumeRole?: AssumeRole, useRegionalStsEndpoints?: boolean): string[] {
    const lines = new Array<string>();
    // Better echo the location here; if this fails, the error message only contains
    // the unexpanded variables by default. It might fail if you're running an old
    // definition of the CodeBuild project--the permissions will have been changed
    // to only allow downloading the very latest version.
    lines.push(`echo "Downloading scripts from s3://\${${S3_BUCKET_ENV}}/\${${S3_KEY_ENV}}"`);
    lines.push(`aws s3 cp s3://\${${S3_BUCKET_ENV}}/\${${S3_KEY_ENV}} /tmp`);
    lines.push('mkdir -p /tmp/scriptdir');
    lines.push(`unzip /tmp/$(basename \$${S3_KEY_ENV}) -d /tmp/scriptdir`);

    if (assumeRole) {

      if (assumeRole.refresh) {

        const awsHome = '~/.aws';

        const profileName = assumeRole.profileName ?? 'long-running-profile';

        lines.push(`mkdir -p ${awsHome}`);
        lines.push(`touch ${awsHome}/credentials`);
        lines.push(`config=${awsHome}/config`);
        lines.push(`echo [profile ${profileName}]>> $\{config\}`);
        lines.push('echo credential_source = EcsContainer >> $\{config\}');
        lines.push(`echo role_session_name = ${assumeRole.sessionName} >> $\{config\}`);
        lines.push(`echo role_arn = ${assumeRole.roleArn} >> $config`);

        if (assumeRole.externalId) {
          lines.push(`echo external_id = ${assumeRole.externalId} >> $config`);
        }

        // let the application code know which role is being used.
        lines.push(`export AWS_PROFILE=${profileName}`);

        // force the AWS SDK for JavaScript to actually load the config file (do automatically so users don't forget)
        lines.push('export AWS_SDK_LOAD_CONFIG=1');

      } else {

        const externalId = assumeRole.externalId ? `--external-id "${assumeRole.externalId}"` : '';
        const StsEndpoints = useRegionalStsEndpoints ? 'regional' : 'legacy';

        lines.push('creds=$(mktemp -d)/creds.json');
        lines.push(`AWS_STS_REGIONAL_ENDPOINTS=${StsEndpoints} aws sts assume-role --role-arn "${assumeRole.roleArn}" --role-session-name "${assumeRole.sessionName}" ${externalId} > $creds`);
        lines.push('export AWS_ACCESS_KEY_ID="$(cat ${creds} | grep "AccessKeyId" | cut -d\'"\' -f 4)"');
        lines.push('export AWS_SECRET_ACCESS_KEY="$(cat ${creds} | grep "SecretAccessKey" | cut -d\'"\' -f 4)"');
        lines.push('export AWS_SESSION_TOKEN="$(cat ${creds} | grep "SessionToken" | cut -d\'"\' -f 4)"');
      }
    }

    return lines;
  }

  public buildCommands(entrypoint: string): string[] {
    return [
      'export SCRIPT_DIR=/tmp/scriptdir',
      `echo "Running ${entrypoint}"`,
      `/bin/bash /tmp/scriptdir/${entrypoint}`,
    ];
  }
}

/**
 * A Windows Platform
 */
export class WindowsPlatform extends ShellPlatform {
  public readonly platformType = PlatformType.Windows;

  public prebuildCommands(assumeRole?: AssumeRole, _useRegionalStsEndpoints?: boolean): string[] {
    if (assumeRole) {
      throw new Error('assumeRole is not supported on Windows: https://github.com/awslabs/aws-delivlib/issues/57');
    }

    return [
      // Would love to do downloading here and executing in the next step,
      // but I don't know how to propagate the value of $TEMPDIR.
      //
      // Punting for someone who knows PowerShell well enough.
    ];
  }

  public buildCommands(entrypoint: string): string[] {
    return [
      'Set-Variable -Name TEMPDIR -Value (New-TemporaryFile).DirectoryName',
      `aws s3 cp s3://$env:${S3_BUCKET_ENV}/$env:${S3_KEY_ENV} $TEMPDIR\\scripts.zip`,
      'New-Item -ItemType Directory -Path $TEMPDIR\\scriptdir',
      'Expand-Archive -Path $TEMPDIR/scripts.zip -DestinationPath $TEMPDIR\\scriptdir',
      '$env:SCRIPT_DIR = "$TEMPDIR\\scriptdir"',
      `& $TEMPDIR\\scriptdir\\${entrypoint}`,
    ];
  }
}
