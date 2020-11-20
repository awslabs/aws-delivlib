import '@monocdk-experiment/assert/jest';
import {
  Stack,
  aws_events as events,
  Duration,
} from 'monocdk';
import { EcrRegistrySync, RegistryImageSource } from '../lib/registry-sync';

describe('EcrRegistrySync', () => {
  test('default', () => {
    const stack = new Stack();
    new EcrRegistrySync(stack, 'EcrRegistrySync', {
      images: [RegistryImageSource.fromDockerHub('docker-image')],
      dockerhubCreds: {
        usernameKey: 'username-key',
        passwordKey: 'password-key',
        secretArn: 'arn:aws:secretsmanager:us-west-2:111122223333:secret:123aass',
      },
    });

    expect(stack).toHaveResourceLike('AWS::CodeBuild::Project', {
      Environment: {
        EnvironmentVariables: [
          {
            Name: 'DOCKERHUB_USERNAME',
            Type: 'SECRETS_MANAGER',
            Value: '123aass:username-key:AWSCURRENT',
          },
          {
            Name: 'DOCKERHUB_PASSWORD',
            Type: 'SECRETS_MANAGER',
            Value: '123aass:password-key:AWSCURRENT',
          },
        ],
        Image: 'jsii/superchain',
        RegistryCredential: {
          Credential: 'arn:aws:secretsmanager:us-west-2:111122223333:secret:123aass',
          CredentialProvider: 'SECRETS_MANAGER',
        },
      },
      Source: {
        BuildSpec: {
          'Fn::Join': [
            '',
            [
              '{\n  "version": "0.2",\n  "phases": {\n    "build": {\n      "commands": [\n        "nohup /usr/bin/dockerd --host=unix:///var/run/docker.sock --host=tcp://127.0.0.1:2375 --storage-driver=overlay2&",\n        "timeout 15 sh -c \\"until docker info; do echo .; sleep 1; done\\"",\n        "docker login -u ${DOCKERHUB_USERNAME} -p ${DOCKERHUB_PASSWORD}",\n        "aws ecr get-login-password | docker login --username AWS --password-stdin ',
              {
                Ref: 'AWS::AccountId',
              },
              '.dkr.ecr.',
              {
                Ref: 'AWS::Region',
              },
              '.amazonaws.com",\n        "docker pull library/docker-image:latest",\n        "docker tag library/docker-image:latest ',
              {
                Ref: 'AWS::AccountId',
              },
              '.dkr.ecr.',
              {
                Ref: 'AWS::Region',
              },
              '.amazonaws.com/library/docker-image:latest",\n        "docker push ',
              {
                Ref: 'AWS::AccountId',
              },
              '.dkr.ecr.',
              {
                Ref: 'AWS::Region',
              },
              '.amazonaws.com/library/docker-image:latest",\n        "docker image prune --all --force"\n      ]\n    }\n  }\n}',
            ],
          ],
        },
      },
    });

    expect(stack).not.toHaveResource('Custom::AWS');
    expect(stack).not.toHaveResource('AWS::Lambda::Function');
    expect(stack).not.toHaveResource('AWS::Events::Rule');
  });

  test('autoStart', () => {
    const stack = new Stack();
    new EcrRegistrySync(stack, 'EcrRegistrySync', {
      images: [RegistryImageSource.fromDockerHub('docker-image')],
      dockerhubCreds: {
        usernameKey: 'username-key',
        passwordKey: 'password-key',
        secretArn: 'arn:aws:secretsmanager:us-west-2:111122223333:secret:123aass',
      },
      autoStart: true,
    });

    expect(stack).toHaveResource('Custom::AWS');
  });

  test('schedule', () => {
    const stack = new Stack();
    new EcrRegistrySync(stack, 'EcrRegistrySync', {
      images: [RegistryImageSource.fromDockerHub('docker-image')],
      dockerhubCreds: {
        usernameKey: 'username-key',
        passwordKey: 'password-key',
        secretArn: 'arn:aws:secretsmanager:us-west-2:111122223333:secret:123aass',
      },
      schedule: events.Schedule.rate(Duration.hours(1)),
    });

    expect(stack).toHaveResource('AWS::Events::Rule', {
      ScheduleExpression: 'rate(1 hour)',
    });
  });
});