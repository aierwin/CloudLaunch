const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const mime = require('mime-types');

const {
  S3Client,
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketPolicyCommand,
  PutBucketWebsiteCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
  waitUntilBucketExists
} = require('@aws-sdk/client-s3');

const {
  CloudFrontClient,
  CreateDistributionCommand,
  GetDistributionCommand,
  GetDistributionConfigCommand,
  UpdateDistributionCommand,
  DeleteDistributionCommand,
  CreateInvalidationCommand
} = require('@aws-sdk/client-cloudfront');

let mainWindow;

// ---- Persistent Storage Paths ----

const STORE_DIR = path.join(app.getPath('userData'), 'data');
const CREDENTIALS_FILE = path.join(STORE_DIR, 'credentials.json');
const DEPLOYMENTS_FILE = path.join(STORE_DIR, 'deployments.json');

function ensureStoreDir() {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

// ---- Credential Storage ----

function saveCredentials(accessKeyId, secretAccessKey, region) {
  ensureStoreDir();
  let secretData;
  if (safeStorage.isEncryptionAvailable()) {
    secretData = safeStorage.encryptString(secretAccessKey).toString('base64');
  } else {
    secretData = Buffer.from(secretAccessKey).toString('base64');
  }
  const data = { accessKeyId, secretAccessKey: secretData, region, encrypted: safeStorage.isEncryptionAvailable() };
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2));
}

function loadCredentials() {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8'));
    let secret;
    if (data.encrypted && safeStorage.isEncryptionAvailable()) {
      secret = safeStorage.decryptString(Buffer.from(data.secretAccessKey, 'base64'));
    } else if (!data.encrypted) {
      secret = Buffer.from(data.secretAccessKey, 'base64').toString('utf-8');
    } else {
      return null;
    }
    return { accessKeyId: data.accessKeyId, secretAccessKey: secret, region: data.region };
  } catch {
    return null;
  }
}

function clearCredentials() {
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) fs.unlinkSync(CREDENTIALS_FILE);
  } catch { /* ignore */ }
}

// ---- Deployment Storage ----

function loadDeployments() {
  try {
    if (!fs.existsSync(DEPLOYMENTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveDeploymentsList(deployments) {
  ensureStoreDir();
  fs.writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(deployments, null, 2));
}

function addDeployment(deployment) {
  const deployments = loadDeployments();
  deployments.unshift(deployment);
  saveDeploymentsList(deployments);
}

function removeDeployment(id) {
  const deployments = loadDeployments().filter(d => d.id !== id);
  saveDeploymentsList(deployments);
}

function updateDeploymentRecord(id, updates) {
  const deployments = loadDeployments();
  const idx = deployments.findIndex(d => d.id === id);
  if (idx >= 0) {
    deployments[idx] = { ...deployments[idx], ...updates };
    saveDeploymentsList(deployments);
  }
}

// ---- Window ----

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 653,
    minWidth: 860,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a1a',
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// --- IPC Handlers ---

ipcMain.handle('open-external', async (_event, url) => {
  shell.openExternal(url);
});

ipcMain.handle('open-in-app', async (_event, { app: appName, directoryPath }) => {
  const { exec } = require('child_process');
  switch (appName) {
    case 'finder':
      shell.openPath(directoryPath);
      break;
    case 'vscode':
      exec(`open -a "Visual Studio Code" "${directoryPath}"`);
      break;
    case 'cursor':
      exec(`open -a "Cursor" "${directoryPath}"`);
      break;
  }
});

// Credentials
ipcMain.handle('load-credentials', async () => {
  return loadCredentials();
});

ipcMain.handle('save-credentials', async (_event, { accessKeyId, secretAccessKey, region }) => {
  saveCredentials(accessKeyId, secretAccessKey, region);
  return true;
});

ipcMain.handle('clear-credentials', async () => {
  clearCredentials();
  return true;
});

// Deployments
ipcMain.handle('get-deployments', async () => {
  return loadDeployments();
});

ipcMain.handle('save-deployment', async (_event, deployment) => {
  addDeployment(deployment);
  return true;
});

ipcMain.handle('remove-deployment-record', async (_event, id) => {
  removeDeployment(id);
  return true;
});

// CloudFront status
ipcMain.handle('get-distribution-status', async (_event, { accessKeyId, secretAccessKey, distributionId }) => {
  try {
    const credentials = { accessKeyId, secretAccessKey };
    const cloudfront = new CloudFrontClient({ region: 'us-east-1', credentials });
    const result = await cloudfront.send(new GetDistributionCommand({ Id: distributionId }));
    return {
      status: result.Distribution.Status,
      enabled: result.Distribution.DistributionConfig.Enabled
    };
  } catch (err) {
    return { status: 'Unknown', enabled: null, error: err.message };
  }
});

ipcMain.handle('disable-distribution', async (_event, { accessKeyId, secretAccessKey, distributionId }) => {
  try {
    const credentials = { accessKeyId, secretAccessKey };
    const cloudfront = new CloudFrontClient({ region: 'us-east-1', credentials });
    const distConfig = await cloudfront.send(new GetDistributionConfigCommand({ Id: distributionId }));

    if (!distConfig.DistributionConfig.Enabled) {
      return { success: true, alreadyDisabled: true };
    }

    const updatedConfig = { ...distConfig.DistributionConfig, Enabled: false };
    await cloudfront.send(new UpdateDistributionCommand({
      Id: distributionId,
      DistributionConfig: updatedConfig,
      IfMatch: distConfig.ETag
    }));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Directory selection
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    message: 'Select the directory containing your website files',
    buttonLabel: 'Select'
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const dirPath = result.filePaths[0];
  const files = walkDirectory(dirPath);
  return { path: dirPath, fileCount: files.length };
});

// Deploy (new deployment)
ipcMain.handle('deploy', async (event, config) => {
  try {
    const result = await deployToAWS(config, (progress) => {
      event.sender.send('deploy-progress', progress);
    });
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Update deployment (upload files + invalidate)
ipcMain.handle('update-deployment', async (event, config) => {
  try {
    const result = await updateDeploymentAWS(config, (progress) => {
      event.sender.send('operation-progress', progress);
    });
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Delete deployment (tear down all AWS resources)
ipcMain.handle('delete-deployment', async (event, config) => {
  try {
    const result = await deleteDeploymentAWS(config, (progress) => {
      event.sender.send('operation-progress', progress);
    });
    // Remove from local records on success
    removeDeployment(config.deploymentId);
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// --- Helpers ---

function walkDirectory(dirPath) {
  const files = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      files.push(...walkDirectory(fullPath));
    } else {
      if (entry.name.startsWith('.')) continue;
      files.push(fullPath);
    }
  }
  return files;
}

function sanitizeProjectName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// --- Deploy (new) ---

async function deployToAWS(config, onProgress) {
  const { accessKeyId, secretAccessKey, region, projectName, directoryPath } = config;

  const sanitizedName = sanitizeProjectName(projectName);
  const shortId = uuidv4().split('-')[0];
  const bucketName = `${sanitizedName}-${shortId}`;

  const credentials = { accessKeyId, secretAccessKey };

  const s3 = new S3Client({ region, credentials });
  const cloudfront = new CloudFrontClient({ region: 'us-east-1', credentials });

  // Step 1: Create S3 Bucket
  onProgress({ step: 'creating-bucket', status: 'in-progress', message: `Creating bucket: ${bucketName}` });
  try {
    const createParams = { Bucket: bucketName };
    if (region !== 'us-east-1') {
      createParams.CreateBucketConfiguration = { LocationConstraint: region };
    }
    await s3.send(new CreateBucketCommand(createParams));
    await waitUntilBucketExists({ client: s3, maxWaitTime: 30 }, { Bucket: bucketName });
    onProgress({ step: 'creating-bucket', status: 'complete', message: `Bucket created: ${bucketName}` });
  } catch (err) {
    onProgress({ step: 'creating-bucket', status: 'error', message: err.message });
    throw new Error(`Failed to create bucket: ${err.message}`);
  }

  // Step 2: Disable Block Public Access
  onProgress({ step: 'configuring-access', status: 'in-progress', message: 'Disabling block public access...' });
  try {
    await s3.send(new PutPublicAccessBlockCommand({
      Bucket: bucketName,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: false,
        IgnorePublicAcls: false,
        BlockPublicPolicy: false,
        RestrictPublicBuckets: false
      }
    }));
    onProgress({ step: 'configuring-access', status: 'complete', message: 'Public access enabled' });
  } catch (err) {
    onProgress({ step: 'configuring-access', status: 'error', message: err.message });
    throw new Error(`Failed to configure public access: ${err.message}`);
  }

  // Step 3: Set Bucket Policy
  onProgress({ step: 'configuring-policy', status: 'in-progress', message: 'Setting bucket policy...' });
  try {
    const policy = {
      Version: '2012-10-17',
      Statement: [{
        Sid: 'PublicReadGetObject',
        Effect: 'Allow',
        Principal: '*',
        Action: 's3:GetObject',
        Resource: `arn:aws:s3:::${bucketName}/*`
      }]
    };
    await s3.send(new PutBucketPolicyCommand({
      Bucket: bucketName,
      Policy: JSON.stringify(policy)
    }));
    onProgress({ step: 'configuring-policy', status: 'complete', message: 'Bucket policy set for public read' });
  } catch (err) {
    onProgress({ step: 'configuring-policy', status: 'error', message: err.message });
    throw new Error(`Failed to set bucket policy: ${err.message}`);
  }

  // Step 4: Enable Static Website Hosting
  onProgress({ step: 'configuring-website', status: 'in-progress', message: 'Enabling static website hosting...' });
  try {
    await s3.send(new PutBucketWebsiteCommand({
      Bucket: bucketName,
      WebsiteConfiguration: {
        IndexDocument: { Suffix: 'index.html' },
        ErrorDocument: { Key: 'index.html' }
      }
    }));
    onProgress({ step: 'configuring-website', status: 'complete', message: 'Static website hosting enabled' });
  } catch (err) {
    onProgress({ step: 'configuring-website', status: 'error', message: err.message });
    throw new Error(`Failed to enable website hosting: ${err.message}`);
  }

  // Step 5: Upload Files
  const files = walkDirectory(directoryPath);
  onProgress({ step: 'uploading', status: 'in-progress', message: `Uploading 0/${files.length} files...`, current: 0, total: files.length });

  try {
    for (let i = 0; i < files.length; i++) {
      const filePath = files[i];
      const relativePath = path.relative(directoryPath, filePath).split(path.sep).join('/');
      const contentType = mime.lookup(filePath) || 'application/octet-stream';
      const fileContent = fs.readFileSync(filePath);

      await s3.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: relativePath,
        Body: fileContent,
        ContentType: contentType
      }));

      onProgress({
        step: 'uploading',
        status: 'in-progress',
        message: `Uploading ${i + 1}/${files.length} files...`,
        current: i + 1,
        total: files.length,
        fileName: relativePath
      });
    }
    onProgress({ step: 'uploading', status: 'complete', message: `${files.length} files uploaded` });
  } catch (err) {
    onProgress({ step: 'uploading', status: 'error', message: err.message });
    throw new Error(`Failed to upload files: ${err.message}`);
  }

  // Step 6: Create CloudFront Distribution
  onProgress({ step: 'creating-distribution', status: 'in-progress', message: 'Creating CloudFront distribution...' });

  const originDomain = `${bucketName}.s3-website-${region}.amazonaws.com`;

  try {
    const distResult = await cloudfront.send(new CreateDistributionCommand({
      DistributionConfig: {
        CallerReference: Date.now().toString(),
        Comment: `${projectName} - deployed by CloudLaunch`,
        Enabled: true,
        DefaultRootObject: 'index.html',
        Origins: {
          Quantity: 1,
          Items: [{
            Id: 'S3WebsiteOrigin',
            DomainName: originDomain,
            CustomOriginConfig: {
              HTTPPort: 80,
              HTTPSPort: 443,
              OriginProtocolPolicy: 'http-only',
              OriginSslProtocols: { Quantity: 1, Items: ['TLSv1.2'] }
            }
          }]
        },
        DefaultCacheBehavior: {
          TargetOriginId: 'S3WebsiteOrigin',
          ViewerProtocolPolicy: 'redirect-to-https',
          AllowedMethods: {
            Quantity: 2,
            Items: ['GET', 'HEAD'],
            CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] }
          },
          ForwardedValues: {
            QueryString: false,
            Cookies: { Forward: 'none' }
          },
          MinTTL: 0,
          DefaultTTL: 86400,
          MaxTTL: 31536000,
          Compress: true
        }
      }
    }));

    const cloudFrontDomain = distResult.Distribution.DomainName;
    const distributionId = distResult.Distribution.Id;
    const cloudFrontUrl = `https://${cloudFrontDomain}`;
    const s3WebsiteUrl = `http://${originDomain}`;

    onProgress({
      step: 'creating-distribution',
      status: 'complete',
      message: 'CloudFront distribution created'
    });

    onProgress({
      step: 'complete',
      status: 'complete',
      message: 'Deployment complete!',
      cloudFrontUrl,
      s3WebsiteUrl,
      bucketName,
      distributionId
    });

    return { cloudFrontUrl, s3WebsiteUrl, bucketName, distributionId };
  } catch (err) {
    onProgress({ step: 'creating-distribution', status: 'error', message: err.message });
    throw new Error(`Failed to create CloudFront distribution: ${err.message}`);
  }
}

// --- Update Deployment (upload files + invalidate cache) ---

async function updateDeploymentAWS(config, onProgress) {
  const { accessKeyId, secretAccessKey, region, bucketName, distributionId, directoryPath } = config;

  const credentials = { accessKeyId, secretAccessKey };
  const s3 = new S3Client({ region, credentials });
  const cloudfront = new CloudFrontClient({ region: 'us-east-1', credentials });

  // Step 1: Upload files
  const files = walkDirectory(directoryPath);
  onProgress({ step: 'uploading', status: 'in-progress', message: `Uploading 0/${files.length} files...`, current: 0, total: files.length });

  try {
    for (let i = 0; i < files.length; i++) {
      const filePath = files[i];
      const relativePath = path.relative(directoryPath, filePath).split(path.sep).join('/');
      const contentType = mime.lookup(filePath) || 'application/octet-stream';
      const fileContent = fs.readFileSync(filePath);

      await s3.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: relativePath,
        Body: fileContent,
        ContentType: contentType
      }));

      onProgress({
        step: 'uploading',
        status: 'in-progress',
        message: `Uploading ${i + 1}/${files.length} files...`,
        current: i + 1,
        total: files.length,
        fileName: relativePath
      });
    }
    onProgress({ step: 'uploading', status: 'complete', message: `${files.length} files uploaded` });
  } catch (err) {
    onProgress({ step: 'uploading', status: 'error', message: err.message });
    throw new Error(`Failed to upload files: ${err.message}`);
  }

  // Step 2: Create CloudFront invalidation
  onProgress({ step: 'invalidating', status: 'in-progress', message: 'Creating cache invalidation...' });
  try {
    await cloudfront.send(new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {
        CallerReference: Date.now().toString(),
        Paths: {
          Quantity: 1,
          Items: ['/*']
        }
      }
    }));
    onProgress({ step: 'invalidating', status: 'complete', message: 'Cache invalidation created (propagates in 5-15 min)' });
  } catch (err) {
    onProgress({ step: 'invalidating', status: 'error', message: err.message });
    throw new Error(`Failed to create invalidation: ${err.message}`);
  }

  onProgress({ step: 'complete', status: 'complete', message: 'Update complete!' });
  return { success: true };
}

// --- Delete Deployment (tear down all AWS resources) ---

async function deleteDeploymentAWS(config, onProgress) {
  const { accessKeyId, secretAccessKey, region, bucketName, distributionId } = config;

  const credentials = { accessKeyId, secretAccessKey };
  const s3 = new S3Client({ region, credentials });
  const cloudfront = new CloudFrontClient({ region: 'us-east-1', credentials });

  // Step 1: Delete all objects in bucket
  onProgress({ step: 'deleting-objects', status: 'in-progress', message: 'Deleting bucket objects...' });
  try {
    let continuationToken;
    let totalDeleted = 0;
    do {
      const listParams = { Bucket: bucketName };
      if (continuationToken) listParams.ContinuationToken = continuationToken;

      const listResult = await s3.send(new ListObjectsV2Command(listParams));
      if (listResult.Contents && listResult.Contents.length > 0) {
        await s3.send(new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: {
            Objects: listResult.Contents.map(obj => ({ Key: obj.Key })),
            Quiet: true
          }
        }));
        totalDeleted += listResult.Contents.length;
        onProgress({ step: 'deleting-objects', status: 'in-progress', message: `Deleted ${totalDeleted} objects...` });
      }
      continuationToken = listResult.IsTruncated ? listResult.NextContinuationToken : undefined;
    } while (continuationToken);

    onProgress({ step: 'deleting-objects', status: 'complete', message: `${totalDeleted} objects deleted` });
  } catch (err) {
    onProgress({ step: 'deleting-objects', status: 'error', message: err.message });
    throw new Error(`Failed to delete bucket objects: ${err.message}`);
  }

  // Step 2: Delete bucket
  onProgress({ step: 'deleting-bucket', status: 'in-progress', message: `Deleting bucket: ${bucketName}` });
  try {
    await s3.send(new DeleteBucketCommand({ Bucket: bucketName }));
    onProgress({ step: 'deleting-bucket', status: 'complete', message: 'Bucket deleted' });
  } catch (err) {
    onProgress({ step: 'deleting-bucket', status: 'error', message: err.message });
    throw new Error(`Failed to delete bucket: ${err.message}`);
  }

  // Step 3: Check if distribution needs disabling
  onProgress({ step: 'disabling-distribution', status: 'in-progress', message: 'Checking distribution status...' });
  try {
    const distCheck = await cloudfront.send(new GetDistributionCommand({ Id: distributionId }));
    const isEnabled = distCheck.Distribution.DistributionConfig.Enabled;
    const isDeployed = distCheck.Distribution.Status === 'Deployed';

    if (isEnabled) {
      // Distribution is still enabled — disable it first
      onProgress({ step: 'disabling-distribution', status: 'in-progress', message: 'Disabling CloudFront distribution...' });
      const distConfig = await cloudfront.send(new GetDistributionConfigCommand({ Id: distributionId }));
      const updatedConfig = { ...distConfig.DistributionConfig, Enabled: false };
      await cloudfront.send(new UpdateDistributionCommand({
        Id: distributionId,
        DistributionConfig: updatedConfig,
        IfMatch: distConfig.ETag
      }));
      onProgress({ step: 'disabling-distribution', status: 'complete', message: 'Distribution disable initiated' });
    } else if (!isDeployed) {
      // Already disabled but still propagating
      onProgress({ step: 'disabling-distribution', status: 'complete', message: 'Distribution already disabling' });
    } else {
      // Already disabled and deployed — skip
      onProgress({ step: 'disabling-distribution', status: 'complete', message: 'Distribution already disabled' });
    }
  } catch (err) {
    onProgress({ step: 'disabling-distribution', status: 'error', message: err.message });
    throw new Error(`Failed to disable distribution: ${err.message}`);
  }

  // Step 4: Wait for distribution to reach Deployed state (disabled)
  onProgress({ step: 'waiting-distribution', status: 'in-progress', message: 'Waiting for distribution to finish disabling...' });
  try {
    let ready = false;
    let attempts = 0;
    const maxAttempts = 120; // 30 min max at 15s intervals

    while (!ready && attempts < maxAttempts) {
      const distStatus = await cloudfront.send(new GetDistributionCommand({ Id: distributionId }));
      if (distStatus.Distribution.Status === 'Deployed' && !distStatus.Distribution.DistributionConfig.Enabled) {
        ready = true;
      } else {
        attempts++;
        const elapsed = attempts * 15;
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        onProgress({
          step: 'waiting-distribution',
          status: 'in-progress',
          message: `Waiting for distribution to finish disabling... (${mins}m ${secs}s)`
        });
        await new Promise(resolve => setTimeout(resolve, 15000));
      }
    }

    if (!ready) {
      throw new Error('Timed out waiting for CloudFront distribution to disable.');
    }
    onProgress({ step: 'waiting-distribution', status: 'complete', message: 'Distribution ready for deletion' });
  } catch (err) {
    if (err.message.includes('Timed out')) {
      onProgress({ step: 'waiting-distribution', status: 'error', message: err.message });
      throw err;
    }
    onProgress({ step: 'waiting-distribution', status: 'error', message: err.message });
    throw new Error(`Failed waiting for distribution: ${err.message}`);
  }

  // Step 5: Delete CloudFront distribution
  onProgress({ step: 'deleting-distribution', status: 'in-progress', message: 'Deleting CloudFront distribution...' });
  try {
    const freshConfig = await cloudfront.send(new GetDistributionConfigCommand({ Id: distributionId }));
    await cloudfront.send(new DeleteDistributionCommand({
      Id: distributionId,
      IfMatch: freshConfig.ETag
    }));
    onProgress({ step: 'deleting-distribution', status: 'complete', message: 'Distribution deleted' });
  } catch (err) {
    onProgress({ step: 'deleting-distribution', status: 'error', message: err.message });
    throw new Error(`Failed to delete distribution: ${err.message}`);
  }

  onProgress({ step: 'complete', status: 'complete', message: 'All resources deleted' });
  return { success: true };
}
