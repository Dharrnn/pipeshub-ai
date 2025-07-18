import { Response, NextFunction } from 'express';
import {
  AuthenticatedServiceRequest,
  AuthenticatedUserRequest,
} from '../../../libs/middlewares/types';
import { KeyValueStoreService } from '../../../libs/services/keyValueStore.service';
import { Logger } from '../../../libs/services/logger.service';
import { configPaths } from '../paths/paths';
import {
  BadRequestError,
  InternalServerError,
  NotFoundError,
  UnauthorizedError,
} from '../../../libs/errors/http.errors';
import {
  googleWorkspaceBusinessCredentialsSchema,
  googleWorkspaceIndividualCredentialsSchema,
} from '../validator/validators';
import { HTTP_STATUS } from '../../../libs/enums/http-status.enum';
import {
  aiModelRoute,
  AIServiceResponse,
  googleWorkspaceTypes,
  storageTypes,
} from '../constants/constants';
import { EncryptionService } from '../../../libs/encryptor/encryptor';
import { loadConfigurationManagerConfig } from '../config/config';
import { Org } from '../../user_management/schema/org.schema';

import { DefaultStorageConfig } from '../../tokens_manager/services/cm.service';
import { AppConfig } from '../../tokens_manager/config/config';
import { generateFetchConfigAuthToken } from '../../auth/utils/generateAuthToken';
import axios from 'axios';
import { ARANGO_DB_NAME, MONGO_DB_NAME } from '../../../libs/enums/db.enum';
import { ConfigService } from '../services/updateConfig.service';
import {
  ConnectorPublicUrlChangedEvent,
  EntitiesEventProducer,
  Event,
  EventType,
  GmailUpdatesDisabledEvent,
  GmailUpdatesEnabledEvent,
  LLMConfiguredEvent,
  SyncEventProducer,
} from '../services/kafka_events.service';
import {
  AICommandOptions,
  AIServiceCommand,
} from '../../../libs/commands/ai_service/ai.service.command';
import { HttpMethod } from '../../../libs/enums/http-methods.enum';

const logger = Logger.getInstance({
  service: 'ConfigurationManagerController',
});
export const createStorageConfig =
  (
    keyValueStoreService: KeyValueStoreService,
    defaultConfig: DefaultStorageConfig,
  ) =>
  async (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const storageType = req.body.storageType;
      let config: Record<string, any> = {};
      // config coming from file
      config = req.body;
      const configManagerConfig = loadConfigurationManagerConfig();
      // Process configuration based on storage type
      switch (storageType.toLowerCase()) {
        case storageTypes.S3.toLowerCase(): {
          const s3Config = {
            accessKeyId: config.s3AccessKeyId,
            secretAccessKey: config.s3SecretAccessKey,
            region: config.s3Region,
            bucketName: config.s3BucketName,
          };
          const encryptedS3Config = EncryptionService.getInstance(
            configManagerConfig.algorithm,
            configManagerConfig.secretKey,
          ).encrypt(JSON.stringify(s3Config));

          await keyValueStoreService.set<string>(
            configPaths.storageService,
            JSON.stringify({
              storageType: storageTypes.S3,
              s3: encryptedS3Config,
            }),
          );

          logger.info('S3 storage configuration saved successfully');
          break;
        }

        case storageTypes.AZURE_BLOB.toLowerCase(): {
          if (config.azureBlobConnectionString) {
            const encryptedAzureBlobConnectionString =
              EncryptionService.getInstance(
                configManagerConfig.algorithm,
                configManagerConfig.secretKey,
              ).encrypt(config.azureBlobConnectionString);

            await keyValueStoreService.set<string>(
              configPaths.storageService,
              JSON.stringify({
                storageType: storageTypes.AZURE_BLOB,
                azureBlob: encryptedAzureBlobConnectionString,
              }),
            );
          } else {
            const azureBlobConfig = {
              endpointProtocol: config.endpointProtocol || 'https',
              accountName: config.accountName,
              accountKey: config.accountKey,
              endpointSuffix: config.endpointSuffix || 'core.windows.net',
              containerName: config.containerName,
            };
            const encryptedAzureBlobConfig = EncryptionService.getInstance(
              configManagerConfig.algorithm,
              configManagerConfig.secretKey,
            ).encrypt(JSON.stringify(azureBlobConfig));

            await keyValueStoreService.set<string>(
              configPaths.storageService,
              JSON.stringify({
                storageType: storageTypes.AZURE_BLOB,
                azureBlob: encryptedAzureBlobConfig,
              }),
            );
          }
          logger.info('Azure Blob storage configuration saved successfully');
          break;
        }

        case storageTypes.LOCAL.toLowerCase(): {
          const localConfig = {
            mountName: config.mountName || 'PipesHub',
            baseUrl: config.baseUrl || defaultConfig.endpoint,
          };
          await keyValueStoreService.set<string>(
            configPaths.storageService,
            JSON.stringify({
              storageType: storageTypes.LOCAL,
              local: JSON.stringify(localConfig),
            }),
          );

          logger.info('Local storage configuration saved successfully');
          break;
        }

        default:
          throw new BadRequestError(`Unsupported storage type: ${storageType}`);
      }
      res.status(200).json({
        message: 'Storage configuration saved successfully',
      });
    } catch (error: any) {
      logger.error('Error creating storage config', { error });
      next(error);
    }
  };

export const getStorageConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (
    _req: AuthenticatedUserRequest | AuthenticatedServiceRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const storageConfig =
        (await keyValueStoreService.get<string>(configPaths.storageService)) ||
        '{}';

      const parsedConfig = JSON.parse(storageConfig); // Parse JSON string

      const storageType = parsedConfig.storageType;

      if (!storageType) {
        throw new BadRequestError('Storage type not found');
      }

      const configManagerConfig = loadConfigurationManagerConfig();

      if (storageType === storageTypes.S3) {
        const encryptedS3Config = parsedConfig.s3;

        if (encryptedS3Config) {
          const s3Config = EncryptionService.getInstance(
            configManagerConfig.algorithm,
            configManagerConfig.secretKey,
          ).decrypt(encryptedS3Config);

          const { accessKeyId, secretAccessKey, region, bucketName } =
            JSON.parse(s3Config);
          res
            .status(200)
            .json({
              storageType,
              accessKeyId,
              secretAccessKey,
              region,
              bucketName,
            })
            .end();
          return;
        } else {
          throw new BadRequestError('Storage config not found');
        }
      }

      if (storageType === storageTypes.AZURE_BLOB) {
        const encryptedAzureBlobConfig = parsedConfig.azureBlob;
        if (encryptedAzureBlobConfig) {
          const azureBlobConfig = JSON.parse(
            EncryptionService.getInstance(
              configManagerConfig.algorithm,
              configManagerConfig.secretKey,
            ).decrypt(encryptedAzureBlobConfig),
          );

          const {
            endpointProtocol,
            accountName,
            accountKey,
            endpointSuffix,
            containerName,
          } = azureBlobConfig;
          res
            .status(200)
            .json({
              storageType,
              endpointProtocol,
              accountName,
              accountKey,
              endpointSuffix,
              containerName,
            })
            .end();
          return;
        } else {
          throw new BadRequestError('Storage config not found');
        }
      }

      if (storageType === storageTypes.LOCAL) {
        const localConfig = parsedConfig.local;
        res
          .status(200)
          .json(JSON.parse(localConfig || '{}'))
          .end();
        return;
      }

      res.status(HTTP_STATUS.BAD_REQUEST).json({
        message: 'Unsupported storage type',
      });
    } catch (error: any) {
      logger.error('Error getting storage config', { error });
      next(error);
    }
  };

export const createSmtpConfig =
  (
    keyValueStoreService: KeyValueStoreService,
    communicationBackend: string,
    scopedJwtSecret: string,
  ) =>
  async (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        throw new UnauthorizedError('User not Found');
      }
      const smtpConfig = req.body;
      const configManagerConfig = loadConfigurationManagerConfig();
      const encryptedSmtpConfig = EncryptionService.getInstance(
        configManagerConfig.algorithm,
        configManagerConfig.secretKey,
      ).encrypt(JSON.stringify(smtpConfig));
      await keyValueStoreService.set<string>(
        configPaths.smtp,
        encryptedSmtpConfig,
      );
      const config = {
        method: 'post' as const,
        url: `${communicationBackend}/api/v1/mail/updateSmtpConfig`,
        headers: {
          Authorization: `Bearer ${await generateFetchConfigAuthToken(req.user, scopedJwtSecret)}`,
          'Content-Type': 'application/json',
        },
      };

      const response = await axios(config);
      if (response.status != 200) {
        throw new BadRequestError('Error setting smtp config');
      }

      res
        .status(200)
        .json({ message: 'SMTP config created successfully' })
        .end();
    } catch (error: any) {
      logger.error('Error creating smtp config', { error });
      next(error);
    }
  };

export const getSmtpConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (_req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const configManagerConfig = loadConfigurationManagerConfig();
      const encryptedSmtpConfig = await keyValueStoreService.get<string>(
        configPaths.smtp,
      );
      if (encryptedSmtpConfig) {
        const smtpConfig = JSON.parse(
          EncryptionService.getInstance(
            configManagerConfig.algorithm,
            configManagerConfig.secretKey,
          ).decrypt(encryptedSmtpConfig),
        );
        res.status(200).json(smtpConfig).end();
        return;
      }
      res.status(200).json({}).end();
    } catch (error: any) {
      logger.error('Error getting smtp config', { error });
      next(error);
    }
  };

export const getAzureAdAuthConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (_req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const configManagerConfig = loadConfigurationManagerConfig();

      const encryptedAuthConfig = await keyValueStoreService.get<string>(
        configPaths.auth.azureAD,
      );

      if (encryptedAuthConfig) {
        const authConfig = JSON.parse(
          EncryptionService.getInstance(
            configManagerConfig.algorithm,
            configManagerConfig.secretKey,
          ).decrypt(encryptedAuthConfig),
        );
        res.status(200).json(authConfig).end();
      } else {
        res.status(200).json({}).end();
      }
    } catch (error: any) {
      logger.error('Error getting auth config', { error });
      next(error);
    }
  };

export const setAzureAdAuthConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const configManagerConfig = loadConfigurationManagerConfig();

      const { clientId, tenantId } = req.body;
      const authority = `https://login.microsoftonline.com/${tenantId}`;

      const encryptedAuthConfig = EncryptionService.getInstance(
        configManagerConfig.algorithm,
        configManagerConfig.secretKey,
      ).encrypt(JSON.stringify({ clientId, tenantId, authority }));

      await keyValueStoreService.set<string>(
        configPaths.auth.azureAD,
        encryptedAuthConfig,
      );

      res
        .status(200)
        .json({ message: 'Azure AD config created successfully' })
        .end();
    } catch (error: any) {
      logger.error('Error creating smtp config', { error });
      next(error);
    }
  };

export const getMicrosoftAuthConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (_req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const configManagerConfig = loadConfigurationManagerConfig();

      const encryptedAuthConfig = await keyValueStoreService.get<string>(
        configPaths.auth.microsoft,
      );

      if (encryptedAuthConfig) {
        const authConfig = JSON.parse(
          EncryptionService.getInstance(
            configManagerConfig.algorithm,
            configManagerConfig.secretKey,
          ).decrypt(encryptedAuthConfig),
        );
        res.status(200).json(authConfig).end();
      } else {
        res.status(200).json({}).end();
      }
    } catch (error: any) {
      logger.error('Error getting auth config', { error });
      next(error);
    }
  };

export const setMicrosoftAuthConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const configManagerConfig = loadConfigurationManagerConfig();

      const { clientId, tenantId } = req.body;
      const authority = `https://login.microsoftonline.com/${tenantId}`;

      const encryptedAuthConfig = EncryptionService.getInstance(
        configManagerConfig.algorithm,
        configManagerConfig.secretKey,
      ).encrypt(JSON.stringify({ clientId, tenantId, authority }));

      await keyValueStoreService.set<string>(
        configPaths.auth.microsoft,
        encryptedAuthConfig,
      );

      res
        .status(200)
        .json({ message: 'Microsoft Auth config created successfully' })
        .end();
    } catch (error: any) {
      logger.error('Error creating smtp config', { error });
      next(error);
    }
  };

export const getGoogleAuthConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (_req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const configManagerConfig = loadConfigurationManagerConfig();

      const encryptedAuthConfig = await keyValueStoreService.get<string>(
        configPaths.auth.google,
      );

      if (encryptedAuthConfig) {
        const authConfig = JSON.parse(
          EncryptionService.getInstance(
            configManagerConfig.algorithm,
            configManagerConfig.secretKey,
          ).decrypt(encryptedAuthConfig),
        );
        res.status(200).json(authConfig).end();
      } else {
        res.status(200).json({}).end();
      }
    } catch (error: any) {
      logger.error('Error getting auth config', { error });
      next(error);
    }
  };

export const setGoogleAuthConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const configManagerConfig = loadConfigurationManagerConfig();

      const { clientId } = req.body;

      const encryptedAuthConfig = EncryptionService.getInstance(
        configManagerConfig.algorithm,
        configManagerConfig.secretKey,
      ).encrypt(JSON.stringify({ clientId }));

      await keyValueStoreService.set<string>(
        configPaths.auth.google,
        encryptedAuthConfig,
      );

      res
        .status(200)
        .json({ message: 'Google Auth config created successfully' })
        .end();
    } catch (error: any) {
      logger.error('Error creating smtp config', { error });
      next(error);
    }
  };

export const getOAuthConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (_req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const configManagerConfig = loadConfigurationManagerConfig();

      const encryptedAuthConfig = await keyValueStoreService.get<string>(
        configPaths.auth.oauth,
      );

      if (encryptedAuthConfig) {
        const authConfig = JSON.parse(
          EncryptionService.getInstance(
            configManagerConfig.algorithm,
            configManagerConfig.secretKey,
          ).decrypt(encryptedAuthConfig),
        );
        res.status(200).json(authConfig).end();
      } else {
        res.status(200).json({}).end();
      }
    } catch (error: any) {
      logger.error('Error getting OAuth config', { error });
      next(error);
    }
  };

export const setOAuthConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const configManagerConfig = loadConfigurationManagerConfig();

      const {
        providerName,
        clientId,
        clientSecret,
        authorizationUrl,
        tokenEndpoint,
        userInfoEndpoint,
        scope,
        redirectUri,
      } = req.body;

      const oauthConfig = {
        providerName,
        clientId,
        ...(clientSecret && { clientSecret }),
        ...(authorizationUrl && { authorizationUrl }),
        ...(tokenEndpoint && { tokenEndpoint }),
        ...(userInfoEndpoint && { userInfoEndpoint }),
        ...(scope && { scope }),
        ...(redirectUri && { redirectUri }),
      };

      const encryptedAuthConfig = EncryptionService.getInstance(
        configManagerConfig.algorithm,
        configManagerConfig.secretKey,
      ).encrypt(JSON.stringify(oauthConfig));

      await keyValueStoreService.set<string>(
        configPaths.auth.oauth,
        encryptedAuthConfig,
      );

      res
        .status(200)
        .json({ message: 'OAuth config created successfully' })
        .end();
    } catch (error: any) {
      logger.error('Error creating OAuth config', { error });
      next(error);
    }
  };

export const createArangoDbConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const { url, username, password } = req.body;
      const db = ARANGO_DB_NAME;
      const configManagerConfig = loadConfigurationManagerConfig();
      const encryptedArangoDBConfig = EncryptionService.getInstance(
        configManagerConfig.algorithm,
        configManagerConfig.secretKey,
      ).encrypt(JSON.stringify({ url, username, password, db }));
      await keyValueStoreService.set<string>(
        configPaths.db.arangodb,
        encryptedArangoDBConfig,
      );

      res
        .status(200)
        .json({
          message: 'Arango DB config created successfully',
        })
        .end();
    } catch (error: any) {
      logger.error('Error creating db config', { error });
      next(error);
    }
  };

export const getArangoDbConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (_req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const configManagerConfig = loadConfigurationManagerConfig();
      const encryptedArangoDBConfig = await keyValueStoreService.get<string>(
        configPaths.db.arangodb,
      );
      if (encryptedArangoDBConfig) {
        const arangoDBConfig = JSON.parse(
          EncryptionService.getInstance(
            configManagerConfig.algorithm,
            configManagerConfig.secretKey,
          ).decrypt(encryptedArangoDBConfig),
        );
        res.status(200).json(arangoDBConfig).end();
        return;
      }
      res.status(200).json({}).end();
    } catch (error: any) {
      logger.error('Error getting db config', { error });
      next(error);
    }
  };

export const createMongoDbConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const { uri } = req.body;
      const db = MONGO_DB_NAME;
      const configManagerConfig = loadConfigurationManagerConfig();
      const encryptedMongoDBConfig = EncryptionService.getInstance(
        configManagerConfig.algorithm,
        configManagerConfig.secretKey,
      ).encrypt(JSON.stringify({ uri, db }));
      await keyValueStoreService.set<string>(
        configPaths.db.mongodb,
        encryptedMongoDBConfig,
      );

      res
        .status(200)
        .json({
          message: 'Mongo DB config created successfully',
        })
        .end();
    } catch (error: any) {
      logger.error('Error creating db config', { error });
      next(error);
    }
  };

export const getMongoDbConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (_req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const configManagerConfig = loadConfigurationManagerConfig();

      const encryptedMongoDBConfig = await keyValueStoreService.get<string>(
        configPaths.db.mongodb,
      );
      if (encryptedMongoDBConfig) {
        const mongoDBConfig = JSON.parse(
          EncryptionService.getInstance(
            configManagerConfig.algorithm,
            configManagerConfig.secretKey,
          ).decrypt(encryptedMongoDBConfig),
        );

        res.status(200).json(mongoDBConfig).end();
        return;
      }
      res.status(200).json({}).end();
    } catch (error: any) {
      logger.error('Error getting db config', { error });
      next(error);
    }
  };

export const createRedisConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const { host, port, password, tls } = req.body;
      const configManagerConfig = loadConfigurationManagerConfig();
      const encryptedRedisConfig = EncryptionService.getInstance(
        configManagerConfig.algorithm,
        configManagerConfig.secretKey,
      ).encrypt(JSON.stringify({ host, port, password, tls }));
      await keyValueStoreService.set<string>(
        configPaths.keyValueStore.redis,
        encryptedRedisConfig,
      );
      res.status(200).json({ message: 'Redis config created successfully' });
    } catch (error: any) {
      logger.error('Error creating key value store config', { error });
      next(error);
    }
  };

export const getRedisConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (_req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const configManagerConfig = loadConfigurationManagerConfig();
      const encryptedRedisConfig = await keyValueStoreService.get<string>(
        configPaths.keyValueStore.redis,
      );
      if (encryptedRedisConfig) {
        const redisConfig = JSON.parse(
          EncryptionService.getInstance(
            configManagerConfig.algorithm,
            configManagerConfig.secretKey,
          ).decrypt(encryptedRedisConfig),
        );

        res.status(200).json(redisConfig).end();
      } else {
        res.status(200).json({}).end();
      }
    } catch (error: any) {
      logger.error('Error getting key value store config', { error });
      next(error);
    }
  };

export const createKafkaConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const { brokers, sasl } = req.body;
      const configManagerConfig = loadConfigurationManagerConfig();
      const encryptedKafkaConfig = EncryptionService.getInstance(
        configManagerConfig.algorithm,
        configManagerConfig.secretKey,
      ).encrypt(JSON.stringify({ brokers, sasl }));
      await keyValueStoreService.set<string>(
        configPaths.broker.kafka,
        encryptedKafkaConfig,
      );
      const warningMessage = res.getHeader('warning');
      res
        .status(200)
        .json({ message: 'Kafka config created successfully', warningMessage })
        .end();
    } catch (error: any) {
      logger.error('Error creating kafka config', { error });
      next(error);
    }
  };

export const getKafkaConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (_req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const configManagerConfig = loadConfigurationManagerConfig();
      const encryptedKafkaConfig = await keyValueStoreService.get<string>(
        configPaths.broker.kafka,
      );
      if (encryptedKafkaConfig) {
        const kafkaConfig = JSON.parse(
          EncryptionService.getInstance(
            configManagerConfig.algorithm,
            configManagerConfig.secretKey,
          ).decrypt(encryptedKafkaConfig),
        );

        res.status(200).json(kafkaConfig).end();
      } else {
        res.status(200).json({}).end();
      }
    } catch (error: any) {
      logger.error('Error getting kafka config', { error });
      next(error);
    }
  };

export const createGoogleWorkspaceCredentials =
  (
    keyValueStoreService: KeyValueStoreService,
    userId: string,
    orgId: string,
    eventService: SyncEventProducer,
  ) =>
  async (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const org = await Org.findOne({ orgId, isDeleted: false });
      if (!org) {
        throw new BadRequestError('Organisaton not found');
      }
      const userType = org.accountType;

      let configData;
      const configManagerConfig = loadConfigurationManagerConfig();
      let encryptedGoogleWorkspaceConfig: string;
      switch (userType.toLowerCase()) {
        case googleWorkspaceTypes.INDIVIDUAL.toLowerCase():
          {
            configData = req.body;

            // validate config schema

            const validationResult =
              googleWorkspaceIndividualCredentialsSchema.safeParse(configData);
            if (!validationResult.success) {
              throw new BadRequestError(validationResult.error.message);
            }
            const enableRealTimeUpdates = req.body.enableRealTimeUpdates;
            let topicName = '';
            const realTimeUpdatesEnabled =
              typeof enableRealTimeUpdates === 'string'
                ? enableRealTimeUpdates.toLowerCase() === 'true'
                : !!enableRealTimeUpdates;

            if (realTimeUpdatesEnabled) {
              if (!req.body.topicName) {
                throw new BadRequestError(
                  'Topic name is required when real-time updates are enabled',
                );
              }
              topicName = req.body.topicName;
            }
            const {
              access_token,
              refresh_token,
              access_token_expiry_time,
              refresh_token_expiry_time,
            } = configData;

            encryptedGoogleWorkspaceConfig = EncryptionService.getInstance(
              configManagerConfig.algorithm,
              configManagerConfig.secretKey,
            ).encrypt(
              JSON.stringify({
                access_token,
                refresh_token,
                access_token_expiry_time,
                refresh_token_expiry_time,
                enableRealTimeUpdates: realTimeUpdatesEnabled,
                topicName,
              }),
            );
          }
          await keyValueStoreService.set<string>(
            `${configPaths.connectors.googleWorkspace.credentials.individual}/${userId}`,
            encryptedGoogleWorkspaceConfig,
          );
          break;
        case googleWorkspaceTypes.BUSINESS.toLowerCase(): {
          const fileChanged =
            req.body.fileChanged === true || req.body.fileChanged === 'true';
          let existingConfig = null;
          // validate config schema
          if (!fileChanged) {
            try {
              const encryptedExistingConfig =
                await keyValueStoreService.get<string>(
                  `${configPaths.connectors.googleWorkspace.credentials.business}/${orgId}`,
                );

              if (encryptedExistingConfig) {
                existingConfig = JSON.parse(
                  EncryptionService.getInstance(
                    configManagerConfig.algorithm,
                    configManagerConfig.secretKey,
                  ).decrypt(encryptedExistingConfig),
                );

                // We'll use this existing config later
                logger.debug('Using existing config, file not changed');
              } else {
                // No existing config found, need to validate the new file
                throw new BadRequestError('File Not found');
              }
            } catch (error) {
              throw error;
            }
          }

          // Validate admin email regardless of whether file changed
          if (!req.body.adminEmail) {
            throw new BadRequestError(
              'Google Workspace Admin Email is required',
            );
          }
          const adminEmail = req.body.adminEmail;

          // Process real-time updates settings
          const enableRealTimeUpdates = req.body.enableRealTimeUpdates;
          let topicName = '';
          const realTimeUpdatesEnabled =
            enableRealTimeUpdates === undefined
              ? false
              : typeof enableRealTimeUpdates === 'string'
                ? enableRealTimeUpdates.toLowerCase() === 'true'
                : Boolean(enableRealTimeUpdates);

          if (realTimeUpdatesEnabled) {
            if (!req.body.topicName) {
              throw new BadRequestError(
                'Topic name is required when real-time updates are enabled',
              );
            }
            topicName = req.body.topicName;
          }

          logger.debug('enableRealTimeUpdates:', enableRealTimeUpdates);
          logger.debug('realTimeUpdatesEnabled:', realTimeUpdatesEnabled);
          logger.debug('topicName:', topicName);

          let configData;

          if (existingConfig) {
            if (
              existingConfig.topicName != topicName ||
              existingConfig.enableRealTimeUpdates != realTimeUpdatesEnabled
            ) {
              if (realTimeUpdatesEnabled) {
                await eventService.start();
                const event: Event = {
                  eventType: EventType.GmailUpdatesEnabledEvent,
                  timestamp: Date.now(),
                  payload: {
                    orgId,
                    topicName: req.body.topicName,
                  } as GmailUpdatesEnabledEvent,
                };
                await eventService.publishEvent(event);
                await eventService.stop();
              } else {
                await eventService.start();
                const event: Event = {
                  eventType: EventType.GmailUpdatesDisabledEvent,
                  timestamp: Date.now(),
                  payload: {
                    orgId,
                  } as GmailUpdatesDisabledEvent,
                };
                await eventService.publishEvent(event);
                await eventService.stop();
              }
            }
          } else {
            if (realTimeUpdatesEnabled) {
              await eventService.start();
              const event: Event = {
                eventType: EventType.GmailUpdatesEnabledEvent,
                timestamp: Date.now(),
                payload: {
                  orgId,
                  topicName: req.body.topicName,
                } as GmailUpdatesEnabledEvent,
              };
              await eventService.publishEvent(event);
              await eventService.stop();
            }
          }

          if (fileChanged) {
            // Only validate the file if it's changed
            configData = req.body.fileContent;

            const validationResult =
              googleWorkspaceBusinessCredentialsSchema.safeParse(configData);

            if (!validationResult.success) {
              const formattedErrors = validationResult.error.errors
                .map((err) => {
                  const fieldName = err.path[0] || 'Unknown field';
                  return `  • ${fieldName}: ${err.message}  `;
                })
                .join('');

              const errorMessage = `Google Workspace validation failed:\n${formattedErrors}`;
              throw new BadRequestError(errorMessage);
            }
          } else {
            // Use existing file data but with updated settings
            configData = {
              type: existingConfig.type,
              project_id: existingConfig.project_id,
              private_key_id: existingConfig.private_key_id,
              private_key: existingConfig.private_key,
              client_email: existingConfig.client_email,
              client_id: existingConfig.client_id,
              auth_uri: existingConfig.auth_uri,
              token_uri: existingConfig.token_uri,
              auth_provider_x509_cert_url:
                existingConfig.auth_provider_x509_cert_url,
              client_x509_cert_url: existingConfig.client_x509_cert_url,
              universe_domain: existingConfig.universe_domain,
            };
          }

          // Combine file data with updated settings
          const {
            type,
            project_id,
            private_key_id,
            private_key,
            client_email,
            client_id,
            auth_uri,
            token_uri,
            auth_provider_x509_cert_url,
            client_x509_cert_url,
            universe_domain,
          } = configData;

          // Encrypt and store the updated config
          encryptedGoogleWorkspaceConfig = EncryptionService.getInstance(
            configManagerConfig.algorithm,
            configManagerConfig.secretKey,
          ).encrypt(
            JSON.stringify({
              type,
              project_id,
              private_key_id,
              private_key,
              client_email,
              client_id,
              auth_uri,
              token_uri,
              auth_provider_x509_cert_url,
              client_x509_cert_url,
              universe_domain,
              adminEmail,
              enableRealTimeUpdates: realTimeUpdatesEnabled,
              topicName,
            }),
          );

          await keyValueStoreService.set<string>(
            `${configPaths.connectors.googleWorkspace.credentials.business}/${orgId}`,
            encryptedGoogleWorkspaceConfig,
          );
          break;
        }
        default: {
          throw new BadRequestError(
            `Unsupported google workspace type: ${userType}`,
          );
        }
      }
      res.status(200).json({ message: 'Successfully updated' });
    } catch (error: any) {
      logger.error('Error creating google workspace credentials', { error });
      next(error);
    }
  };

export const getGoogleWorkspaceCredentials =
  (keyValueStoreService: KeyValueStoreService, userId: string, orgId: string) =>
  async (_req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const org = await Org.findOne({ orgId, isDeleted: false });
      if (!org) {
        throw new BadRequestError('Organisaton not found');
      }
      const userType = org.accountType;
      const configManagerConfig = loadConfigurationManagerConfig();
      let path;
      let googleWorkspaceCredentials: any;
      let encryptedGoogleWorkspaceCredentials;
      switch (userType.toLowerCase()) {
        case googleWorkspaceTypes.INDIVIDUAL.toLowerCase():
          path = `${configPaths.connectors.googleWorkspace.credentials.individual}/${userId}`;
          const oauthPath = `${configPaths.connectors.googleWorkspace.config}`;

          encryptedGoogleWorkspaceCredentials =
            await keyValueStoreService.get<string>(path);
          const encryptedGoogleWorkspaceOauthConfig =
            await keyValueStoreService.get<string>(oauthPath);

          if (encryptedGoogleWorkspaceOauthConfig) {
            const googleWorkspaceOauthConfig = JSON.parse(
              EncryptionService.getInstance(
                configManagerConfig.algorithm,
                configManagerConfig.secretKey,
              ).decrypt(encryptedGoogleWorkspaceOauthConfig),
            );
            if (encryptedGoogleWorkspaceCredentials) {
              googleWorkspaceCredentials = JSON.parse(
                EncryptionService.getInstance(
                  configManagerConfig.algorithm,
                  configManagerConfig.secretKey,
                ).decrypt(encryptedGoogleWorkspaceCredentials),
              );

              const combinedResponse = {
                ...googleWorkspaceCredentials,
                ...googleWorkspaceOauthConfig,
              };

              res.status(200).json(combinedResponse).end();
            } else {
              res.status(200).json({}).end();
            }
          } else {
            res.status(200).json({}).end();
          }

          break;

        case googleWorkspaceTypes.BUSINESS.toLowerCase():
          path = `${configPaths.connectors.googleWorkspace.credentials.business}/${orgId}`;
          encryptedGoogleWorkspaceCredentials =
            await keyValueStoreService.get<string>(path);
          if (encryptedGoogleWorkspaceCredentials) {
            googleWorkspaceCredentials = JSON.parse(
              EncryptionService.getInstance(
                configManagerConfig.algorithm,
                configManagerConfig.secretKey,
              ).decrypt(encryptedGoogleWorkspaceCredentials),
            );
            res.status(200).json(googleWorkspaceCredentials).end();
          } else {
            res.status(200).json({}).end();
          }
          break;

        default:
          throw new BadRequestError(
            `Unsupported google workspace type: ${userType}`,
          );
      }
    } catch (error: any) {
      logger.error('Error getting google workspace credentials', { error });
      next(error);
    }
  };

export const getGoogleWorkspaceBusinessCredentials =
  (keyValueStoreService: KeyValueStoreService, orgId: string) =>
  async (_req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const configManagerConfig = loadConfigurationManagerConfig();
      let path;
      let googleWorkspaceConfig: any;
      let encryptedGoogleWorkspaceConfig;

      path = `${configPaths.connectors.googleWorkspace.credentials.business}/${orgId}`;
      encryptedGoogleWorkspaceConfig =
        await keyValueStoreService.get<string>(path);
      if (encryptedGoogleWorkspaceConfig) {
        googleWorkspaceConfig = JSON.parse(
          EncryptionService.getInstance(
            configManagerConfig.algorithm,
            configManagerConfig.secretKey,
          ).decrypt(encryptedGoogleWorkspaceConfig),
        );
        res.status(200).json(googleWorkspaceConfig).end();
      } else {
        res.status(200).json({}).end();
      }
    } catch (error: any) {
      logger.error('Error getting google workspace credentials', { error });
      next(error);
    }
  };
export const deleteGoogleWorkspaceCredentials =
  (keyValueStoreService: KeyValueStoreService, orgId: string) =>
  async (_req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const org = await Org.findOne({ orgId, isDeleted: false });
      if (!org) {
        throw new BadRequestError('Organisaton not found');
      }
      const userType = org.accountType;
      let path;
      switch (userType.toLowerCase()) {
        case googleWorkspaceTypes.INDIVIDUAL.toLowerCase():
          throw new UnauthorizedError(
            'Deleting credentials fro individual type not allowed',
          );

        case googleWorkspaceTypes.BUSINESS.toLowerCase():
          path = `${configPaths.connectors.googleWorkspace.credentials.business}/${orgId}`;
          await keyValueStoreService.delete(path);
          res.status(200).json({}).end();
          break;

        default:
          throw new BadRequestError(
            `Unsupported google workspace type: ${userType}`,
          );
      }
    } catch (error: any) {
      logger.error('Error getting google workspace credentials', { error });
      next(error);
    }
  };
export const setGoogleWorkspaceOauthConfig =
  (
    keyValueStoreService: KeyValueStoreService,
    eventService: SyncEventProducer,
    orgId: string,
  ) =>
  async (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const { clientId, clientSecret, enableRealTimeUpdates } = req.body;
      let topicName = '';
      const realTimeUpdatesEnabled =
        enableRealTimeUpdates === undefined
          ? false
          : typeof enableRealTimeUpdates === 'string'
            ? enableRealTimeUpdates.toLowerCase() === 'true'
            : Boolean(enableRealTimeUpdates);

      if (realTimeUpdatesEnabled) {
        if (!req.body.topicName) {
          throw new BadRequestError(
            'Topic name is required when real-time updates are enabled',
          );
        }
        topicName = req.body.topicName;
      }
      const configManagerConfig = loadConfigurationManagerConfig();
      const existingGoogleWorkSpaceConfig =
        await keyValueStoreService.get<string>(
          configPaths.connectors.googleWorkspace.config,
        );
      if (existingGoogleWorkSpaceConfig) {
        const googleWorkSpaceConfig = JSON.parse(
          EncryptionService.getInstance(
            configManagerConfig.algorithm,
            configManagerConfig.secretKey,
          ).decrypt(existingGoogleWorkSpaceConfig),
        );
        if (
          googleWorkSpaceConfig.topicName != topicName ||
          googleWorkSpaceConfig.enableRealTimeUpdates != realTimeUpdatesEnabled
        ) {
          if (realTimeUpdatesEnabled) {
            await eventService.start();
            const event: Event = {
              eventType: EventType.GmailUpdatesEnabledEvent,
              timestamp: Date.now(),
              payload: {
                orgId,
                topicName: req.body.topicName,
              } as GmailUpdatesEnabledEvent,
            };
            await eventService.publishEvent(event);
            await eventService.stop();
          } else {
            await eventService.start();
            const event: Event = {
              eventType: EventType.GmailUpdatesDisabledEvent,
              timestamp: Date.now(),
              payload: {
                orgId,
              } as GmailUpdatesDisabledEvent,
            };
            await eventService.publishEvent(event);
            await eventService.stop();
          }
        }
      } else {
        if (realTimeUpdatesEnabled) {
          await eventService.start();
          const event: Event = {
            eventType: EventType.GmailUpdatesEnabledEvent,
            timestamp: Date.now(),
            payload: {
              orgId,
              topicName: req.body.topicName,
            } as GmailUpdatesEnabledEvent,
          };
          await eventService.publishEvent(event);
          await eventService.stop();
        }
      }

      const encryptedGoogleWorkSpaceConfig = EncryptionService.getInstance(
        configManagerConfig.algorithm,
        configManagerConfig.secretKey,
      ).encrypt(
        JSON.stringify({
          clientId,
          clientSecret,
          enableRealTimeUpdates: realTimeUpdatesEnabled,
          topicName,
        }),
      );
      await keyValueStoreService.set<string>(
        configPaths.connectors.googleWorkspace.config,
        encryptedGoogleWorkSpaceConfig,
      );

      res
        .status(200)
        .json({ message: 'Google Workspace credentials created successfully' });
    } catch (error: any) {
      logger.error('Error creating Google Workspace config', { error });
      next(error);
    }
  };

export const getGoogleWorkspaceOauthConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (_req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const configManagerConfig = loadConfigurationManagerConfig();
      const encryptedGoogleWorkSpaceConfig =
        await keyValueStoreService.get<string>(
          configPaths.connectors.googleWorkspace.config,
        );
      if (encryptedGoogleWorkSpaceConfig) {
        const googleWorkSpaceConfig = JSON.parse(
          EncryptionService.getInstance(
            configManagerConfig.algorithm,
            configManagerConfig.secretKey,
          ).decrypt(encryptedGoogleWorkSpaceConfig),
        );
        res.status(200).json(googleWorkSpaceConfig).end();
      } else {
        res.status(200).json({}).end();
      }
    } catch (error: any) {
      logger.error('Error getting Google Workspace config', { error });
      next(error);
    }
  };

export const createAIModelsConfig =
  (
    keyValueStoreService: KeyValueStoreService,
    eventService: EntitiesEventProducer,
    appConfig: AppConfig,
  ) =>
  async (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const aiConfig = req.body;
      if (!aiConfig) {
        throw new BadRequestError('Invalid configuration passed');
      }

      // Handle LLM health check
      if (aiConfig.llm.length > 0) {
        const aiCommandOptions: AICommandOptions = {
          uri: `${appConfig.aiBackend}/api/v1/llm-health-check`,
          method: HttpMethod.POST,
          headers: req.headers as Record<string, string>,
          body: aiConfig.llm,
        };

        logger.debug('Health Check for AI llm Config API calling');

        // Don't use nested try/catch with next() inside
        const aiServiceCommand = new AIServiceCommand(aiCommandOptions);
        const aiResponseData =
          (await aiServiceCommand.execute()) as AIServiceResponse;

        if (!aiResponseData?.data || aiResponseData.statusCode !== 200) {
          throw new InternalServerError(
            'Failed to do health check of llm configuration, check credentials again',
            aiResponseData?.data,
          );
        }
      }

      // Handle embedding health check
      if (aiConfig.embedding.length > 0) {
        const aiCommandOptions: AICommandOptions = {
          uri: `${appConfig.aiBackend}/api/v1/embedding-health-check`,
          method: HttpMethod.POST,
          headers: req.headers as Record<string, string>,
          body: aiConfig.embedding,
        };

        logger.debug('Health Check for AI embedding Config API calling');

        // Don't use nested try/catch with next() inside
        const aiServiceCommand = new AIServiceCommand(aiCommandOptions);
        const aiResponseData =
          (await aiServiceCommand.execute()) as AIServiceResponse;

        if (!aiResponseData?.data || aiResponseData.statusCode !== 200) {
          throw new InternalServerError(
            'Failed to do health check of embedding configuration, check credentials again',
            aiResponseData?.data,
          );
        }
      }

      // Encrypt and store configuration
      const configManagerConfig = loadConfigurationManagerConfig();
      const encryptedAIConfig = EncryptionService.getInstance(
        configManagerConfig.algorithm,
        configManagerConfig.secretKey,
      ).encrypt(JSON.stringify(aiConfig));

      await keyValueStoreService.set<string>(
        configPaths.aiModels,
        encryptedAIConfig,
      );

      // Handle event publication
      await eventService.start();
      const event: Event = {
        eventType: EventType.LLMConfiguredEvent,
        timestamp: Date.now(),
        payload: {
          credentialsRoute: `${appConfig.cmBackend}/${aiModelRoute}`,
        } as LLMConfiguredEvent,
      };
      await eventService.publishEvent(event);
      await eventService.stop();
      res.status(200).json({ message: 'AI config created successfully' }).end();
    } catch (error: any) {
      logger.error('Error creating ai models config', { error });
      next(error);
    }
  };

export const getAIModelsConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (_req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const configManagerConfig = loadConfigurationManagerConfig();
      const encryptedAIConfig = await keyValueStoreService.get<string>(
        configPaths.aiModels,
      );
      if (encryptedAIConfig) {
        const decryptedAIConfig = JSON.parse(
          EncryptionService.getInstance(
            configManagerConfig.algorithm,
            configManagerConfig.secretKey,
          ).decrypt(encryptedAIConfig),
        );
        res.status(200).json(decryptedAIConfig).end();
        return;
      } else {
        res.status(200).json({}).end();
        return;
      }
    } catch (error: any) {
      logger.error('Error getting ai models config', { error });
      next(error);
    }
  };

export const setSsoAuthConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const { entryPoint, emailKey } = req.body;
      let { certificate } = req.body;
      certificate = certificate
        .replace(/\\n/g, '') // Remove \n
        .replace(/\n/g, '') // Remove newline characters
        .replace(/\s+/g, '') // Remove all whitespace
        .replace(/\\/g, ''); // Remove any remaining backslashes

      // Step 2: Remove BEGIN and END certificate markers if present
      certificate = certificate
        .replace(/-----BEGINCERTIFICATE-----/g, '')
        .replace(/-----ENDCERTIFICATE-----/g, '');

      certificate = certificate
        .replace(/-----BEGIN CERTIFICATE-----/g, '')
        .replace(/-----END ERTIFICATE-----/g, '');
      // Step 3: Ensure the certificate content is clean
      certificate = certificate.trim();
      const configManagerConfig = loadConfigurationManagerConfig();
      const encryptedSsoConfig = EncryptionService.getInstance(
        configManagerConfig.algorithm,
        configManagerConfig.secretKey,
      ).encrypt(JSON.stringify({ certificate, entryPoint, emailKey }));
      await keyValueStoreService.set<string>(
        configPaths.auth.sso,
        encryptedSsoConfig,
      );
      res.status(200).json({ message: 'Sso config created successfully' });
    } catch (error: any) {
      logger.error('Error creating Sso config', { error });
      next(error);
    }
  };

export const getSsoAuthConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (_req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const configManagerConfig = loadConfigurationManagerConfig();
      const encryptedSsoConfig = await keyValueStoreService.get<string>(
        configPaths.auth.sso,
      );
      if (encryptedSsoConfig) {
        const ssoConfig = JSON.parse(
          EncryptionService.getInstance(
            configManagerConfig.algorithm,
            configManagerConfig.secretKey,
          ).decrypt(encryptedSsoConfig),
        );
        res.status(200).json(ssoConfig).end();
        return;
      } else {
        res.status(200).json({}).end();
      }
    } catch (error: any) {
      logger.error('Error getting SsoConfig', { error });
      next(error);
    }
  };

export const createQdrantConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const { port, apiKey, host, grpcPort } = req.body;
      const configManagerConfig = loadConfigurationManagerConfig();
      const encryptedQdrantConfig = EncryptionService.getInstance(
        configManagerConfig.algorithm,
        configManagerConfig.secretKey,
      ).encrypt(JSON.stringify({ port, apiKey, host, grpcPort }));
      await keyValueStoreService.set<string>(
        configPaths.db.qdrant,
        encryptedQdrantConfig,
      );
      const warningMessage = res.getHeader('Warning');
      res.status(200).json({
        message: 'Qdrant config created successfully',
        warningMessage,
      });
    } catch (error: any) {
      logger.error('Error creating Sso config', { error });
      next(error);
    }
  };

export const getQdrantConfig =
  (keyValueStoreService: KeyValueStoreService) =>
  async (_req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const configManagerConfig = loadConfigurationManagerConfig();
      const encryptedQdrantConfig = await keyValueStoreService.get<string>(
        configPaths.db.qdrant,
      );
      if (encryptedQdrantConfig) {
        const qdrantConfig = JSON.parse(
          EncryptionService.getInstance(
            configManagerConfig.algorithm,
            configManagerConfig.secretKey,
          ).decrypt(encryptedQdrantConfig),
        );
        res.status(200).json(qdrantConfig).end();
        return;
      } else {
        res.status(200).json({}).end();
      }
    } catch (error: any) {
      logger.error('Error getting SsoConfig', { error });
      next(error);
    }
  };
export const getFrontendUrl =
  (keyValueStoreService: KeyValueStoreService) =>
  async (_req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const url =
        (await keyValueStoreService.get<string>(configPaths.endpoint)) || '{}';
      const parsedUrl = JSON.parse(url);
      if (parsedUrl?.frontend?.publicEndpoint) {
        res
          .status(200)
          .json({ url: parsedUrl?.frontend?.publicEndpoint })
          .end();
        return;
      } else {
        res.status(200).json({}).end();
      }
    } catch (error: any) {
      logger.error('Error getting Frontend Public Url', { error });
      next(error);
    }
  };

export const setFrontendUrl =
  (
    keyValueStoreService: KeyValueStoreService,
    scopedJwtSecret: string,
    configService: ConfigService,
  ) =>
  async (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        throw new NotFoundError('User not found');
      }
      const { url } = req.body;
      const urls =
        (await keyValueStoreService.get<string>(configPaths.endpoint)) || '{}';
      let parsedUrls = JSON.parse(urls);
      // Preserve existing `auth` object if it exists, otherwise create a new one
      parsedUrls.frontend = {
        ...parsedUrls.frontend,
        publicEndpoint: url,
      };
      // Save the updated object back to configPaths.endpoint
      await keyValueStoreService.set<string>(
        configPaths.endpoint,
        JSON.stringify(parsedUrls),
      );

      const scopedToken = await generateFetchConfigAuthToken(
        req.user,
        scopedJwtSecret,
      );
      const response = await configService.updateConfig(scopedToken);
      if (response.statusCode != 200) {
        throw new BadRequestError('Error updating configs');
      }
      res.status(200).json({
        message: 'Frontend Url saved successfully',
      });
    } catch (error: any) {
      logger.error('Error setting frontend url', { error });
      next(error);
    }
  };

export const getConnectorPublicUrl =
  (keyValueStoreService: KeyValueStoreService) =>
  async (_req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const url =
        (await keyValueStoreService.get<string>(configPaths.endpoint)) || '{}';
      const parsedUrl = JSON.parse(url);
      if (parsedUrl?.connectors?.publicEndpoint) {
        res
          .status(200)
          .json({ url: parsedUrl?.connectors?.publicEndpoint })
          .end();
        return;
      } else {
        res.status(200).json({}).end();
      }
    } catch (error: any) {
      logger.error('Error getting Connector Public Url', { error });
      next(error);
    }
  };

export const setConnectorPublicUrl =
  (
    keyValueStoreService: KeyValueStoreService,
    eventService: SyncEventProducer,
  ) =>
  async (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        throw new NotFoundError('User not found');
      }
      const { url } = req.body;
      const urls =
        (await keyValueStoreService.get<string>(configPaths.endpoint)) || '{}';

      let parsedUrls = JSON.parse(urls);

      // Preserve existing `auth` object if it exists, otherwise create a new one
      parsedUrls.connectors = {
        ...parsedUrls.connectors,
        publicEndpoint: url,
      };

      // Save the updated object back to configPaths.endpoint
      await keyValueStoreService.set<string>(
        configPaths.endpoint,
        JSON.stringify(parsedUrls),
      );

      await eventService.start();
      let event: Event = {
        eventType: EventType.ConnectorPublicUrlChangedEvent,
        timestamp: Date.now(),
        payload: {
          url,
          orgId: req.user.orgId,
        } as ConnectorPublicUrlChangedEvent,
      };
      await eventService.publishEvent(event);

      res.status(200).json({
        message: 'Connector Url saved successfully',
      });
    } catch (error: any) {
      logger.error('Error setting Connector url', { error });
      next(error);
    }
  };

export const toggleMetricsCollection =
  (keyValueStoreService: KeyValueStoreService) =>
  async (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const { enableMetricCollection } = req.body;
      const metricsCollection = JSON.parse(
        (await keyValueStoreService.get<string>(
          configPaths.metricsCollection,
        )) || '{}',
      );

      if (enableMetricCollection !== metricsCollection.enableMetricCollection) {
        metricsCollection.enableMetricCollection = enableMetricCollection;
        await keyValueStoreService.set<string>(
          configPaths.metricsCollection,
          JSON.stringify(metricsCollection),
        );
      }
      res
        .status(200)
        .json({ message: 'Metrics collection toggled successfully' });
    } catch (error: any) {
      logger.error('Error toggling metrics collection', { error });
      next(error);
    }
  };

export const getMetricsCollection =
  (keyValueStoreService: KeyValueStoreService) =>
  async (_req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const metricsCollection = JSON.parse(
        (await keyValueStoreService.get<string>(
          configPaths.metricsCollection,
        )) || '{}',
      );
      res.status(200).json(metricsCollection).end();
    } catch (error: any) {
      logger.error('Error getting metrics collection', { error });
      next(error);
    }
  };

export const setMetricsCollectionPushInterval =
  (keyValueStoreService: KeyValueStoreService) =>
  async (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const { pushIntervalMs } = req.body;

      const metricsCollection = JSON.parse(
        (await keyValueStoreService.get<string>(
          configPaths.metricsCollection,
        )) || '{}',
      );

      if (pushIntervalMs !== metricsCollection.pushIntervalMs) {
        metricsCollection.pushIntervalMs = pushIntervalMs;
        await keyValueStoreService.set<string>(
          configPaths.metricsCollection,
          JSON.stringify(metricsCollection),
        );
      }
      res
        .status(200)
        .json({ message: 'Metrics collection push interval set successfully' });
    } catch (error: any) {
      logger.error('Error setting metrics collection push interval', { error });
      next(error);
    }
  };

export const setMetricsCollectionRemoteServer =
  (keyValueStoreService: KeyValueStoreService) =>
  async (req: AuthenticatedUserRequest, res: Response, next: NextFunction) => {
    try {
      const { serverUrl } = req.body;
      const metricsCollection = JSON.parse(
        (await keyValueStoreService.get<string>(
          configPaths.metricsCollection,
        )) || '{}',
      );
      if (serverUrl !== metricsCollection.serverUrl) {
        metricsCollection.serverUrl = serverUrl;
        await keyValueStoreService.set<string>(
          configPaths.metricsCollection,
          JSON.stringify(metricsCollection),
        );
      }
      res
        .status(200)
        .json({ message: 'Metrics collection remote server set successfully' });
    } catch (error: any) {
      logger.error('Error setting metrics collection remote server', { error });
      next(error);
    }
  };
