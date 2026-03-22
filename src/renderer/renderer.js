// ========================================
// CloudLaunch — App Controller
// ========================================

const state = {
  view: 'loading', // 'dashboard' | 'wizard' | 'operation'
  currentStep: 1,
  totalSteps: 5,
  accessKeyId: '',
  secretAccessKey: '',
  region: 'us-east-1',
  projectName: '',
  directoryPath: '',
  fileCount: 0,
  bucketName: '',
  deploying: false,
  deployments: [],
  hasCredentials: false,
  pendingDeleteId: null,
  operationRunning: false,
  distStatuses: {},       // { [deploymentId]: { status, enabled, loading } }
  statusPollTimer: null,
  pendingRemoveDomainId: null,
  domainSetup: {
    deploymentId: null,
    domain: '',
    certificateArn: '',
    validationRecords: [],
    step: 1
  }
};

// ========================================
// Initialization
// ========================================

async function init() {
  const creds = await window.api.loadCredentials();
  if (creds) {
    state.accessKeyId = creds.accessKeyId;
    state.secretAccessKey = creds.secretAccessKey;
    state.region = creds.region;
    state.hasCredentials = true;

    // Pre-fill form
    document.getElementById('access-key').value = creds.accessKeyId;
    document.getElementById('secret-key').value = creds.secretAccessKey;
    document.getElementById('region').value = creds.region;
    document.getElementById('credentials-saved-hint').style.display = 'block';
    document.querySelectorAll('.wizard-dashboard-btn').forEach(el => el.style.display = '');
  }

  state.deployments = await window.api.getDeployments();

  if (state.hasCredentials) {
    showView('dashboard');
  } else {
    showView('wizard');
  }
}

init();

// ========================================
// View Switching
// ========================================

function showView(view) {
  state.view = view;
  document.getElementById('view-dashboard').style.display = view === 'dashboard' ? '' : 'none';
  document.getElementById('view-wizard').style.display = view === 'wizard' ? '' : 'none';
  document.getElementById('view-operation').style.display = view === 'operation' ? '' : 'none';

  // Stop polling when leaving dashboard
  if (view !== 'dashboard') {
    stopStatusPolling();
  }

  if (view === 'dashboard') {
    renderDashboard();
    fetchAllStatuses();
  }
}

// ========================================
// CloudFront Status Management
// ========================================

function getStatusDisplay(deploymentId) {
  const s = state.distStatuses[deploymentId];
  if (!s || s.loading) {
    return { label: 'Checking...', cssClass: 'status-loading', canDisable: false, canDelete: false };
  }
  if (s.error) {
    return { label: 'Unknown', cssClass: 'status-unknown', canDisable: false, canDelete: false, canRemove: true };
  }
  if (s.enabled && s.status === 'Deployed') {
    return { label: 'Live', cssClass: 'status-live', canDisable: true, canDelete: false };
  }
  if (s.enabled && s.status === 'InProgress') {
    return { label: 'Deploying...', cssClass: 'status-deploying', canDisable: true, canDelete: false };
  }
  if (!s.enabled && s.status === 'InProgress') {
    return { label: 'Disabling...', cssClass: 'status-disabling', canDisable: false, canDelete: false };
  }
  if (!s.enabled && s.status === 'Deployed') {
    return { label: 'Disabled', cssClass: 'status-disabled', canDisable: false, canDelete: true };
  }
  return { label: s.status, cssClass: 'status-unknown', canDisable: false, canDelete: false };
}

async function fetchDistributionStatus(deploymentId) {
  const deployment = state.deployments.find(d => d.id === deploymentId);
  if (!deployment || !state.hasCredentials) return;

  state.distStatuses[deploymentId] = { ...(state.distStatuses[deploymentId] || {}), loading: true };
  updateCardStatus(deploymentId);

  const result = await window.api.getDistributionStatus({
    accessKeyId: state.accessKeyId,
    secretAccessKey: state.secretAccessKey,
    distributionId: deployment.distributionId
  });

  state.distStatuses[deploymentId] = {
    status: result.status,
    enabled: result.enabled,
    error: result.error || null,
    loading: false
  };
  updateCardStatus(deploymentId);
}

async function fetchAllStatuses() {
  if (!state.hasCredentials || state.deployments.length === 0) return;

  // Fetch all in parallel
  await Promise.all(state.deployments.map(d => fetchDistributionStatus(d.id)));

  // Start polling if any are InProgress
  startStatusPollingIfNeeded();
}

function startStatusPollingIfNeeded() {
  stopStatusPolling();

  const hasInProgress = Object.values(state.distStatuses).some(
    s => !s.loading && !s.error && s.status === 'InProgress'
  );

  if (hasInProgress && state.view === 'dashboard') {
    state.statusPollTimer = setInterval(async () => {
      // Only re-fetch the InProgress ones
      const inProgressIds = state.deployments
        .filter(d => {
          const s = state.distStatuses[d.id];
          return s && !s.loading && !s.error && s.status === 'InProgress';
        })
        .map(d => d.id);

      if (inProgressIds.length === 0) {
        stopStatusPolling();
        return;
      }

      await Promise.all(inProgressIds.map(id => fetchDistributionStatus(id)));

      // Check if we should keep polling
      const stillInProgress = Object.values(state.distStatuses).some(
        s => !s.loading && !s.error && s.status === 'InProgress'
      );
      if (!stillInProgress) {
        stopStatusPolling();
      }
    }, 15000);
  }
}

function stopStatusPolling() {
  if (state.statusPollTimer) {
    clearInterval(state.statusPollTimer);
    state.statusPollTimer = null;
  }
}

function updateCardStatus(deploymentId) {
  const card = document.querySelector(`.deployment-card[data-id="${deploymentId}"]`);
  if (!card) return;

  const display = getStatusDisplay(deploymentId);

  // Update status badge
  const badge = card.querySelector('.cf-status-badge');
  if (badge) {
    badge.className = `cf-status-badge ${display.cssClass}`;
    badge.textContent = display.label;
  }

  // Update Disable button
  const disableBtn = card.querySelector('[data-action="disable-distribution"]');
  if (disableBtn) {
    disableBtn.disabled = !display.canDisable;
    // Hide disable button when already disabled
    const s = state.distStatuses[deploymentId];
    if (s && !s.loading && !s.error && !s.enabled && s.status === 'Deployed') {
      disableBtn.style.display = 'none';
    } else {
      disableBtn.style.display = '';
    }
  }

  // Update Delete button
  const deleteBtn = card.querySelector('[data-action="delete-deployment"]');
  if (deleteBtn) {
    deleteBtn.disabled = !display.canDelete;
  }

  // Update Remove button
  const removeBtn = card.querySelector('[data-action="remove-deployment"]');
  if (removeBtn) {
    removeBtn.style.display = display.canRemove ? '' : 'none';
  }

  // Update domain buttons
  const deploymentForDomain = state.deployments.find(d => d.id === card.dataset.id);
  const hasDomain = deploymentForDomain && deploymentForDomain.customDomains && deploymentForDomain.customDomains.length > 0;
  const hasPendingDomain = deploymentForDomain && deploymentForDomain.pendingDomain && deploymentForDomain.pendingDomain.certificateArn;
  const isLive = display.cssClass === 'status-live';
  const isDeploying = display.cssClass === 'status-deploying';
  const canManageDomain = isLive || isDeploying;

  const addDomainBtn = card.querySelector('[data-action="add-domain"]');
  if (addDomainBtn) addDomainBtn.style.display = (!hasDomain && !hasPendingDomain && canManageDomain) ? '' : 'none';

  const resumeDomainBtn = card.querySelector('[data-action="resume-domain"]');
  if (resumeDomainBtn) resumeDomainBtn.style.display = hasPendingDomain ? '' : 'none';

  const cancelDomainBtn = card.querySelector('[data-action="cancel-domain-setup-card"]');
  if (cancelDomainBtn) cancelDomainBtn.style.display = hasPendingDomain ? '' : 'none';
}

// ========================================
// Dashboard
// ========================================

function renderDashboard() {
  // Update credentials status
  const statusEl = document.getElementById('credentials-status');
  if (state.hasCredentials) {
    const masked = state.accessKeyId.slice(0, 4) + '...' + state.accessKeyId.slice(-4);
    statusEl.textContent = `Credentials: ${masked} (${state.region})`;
  } else {
    statusEl.textContent = 'No credentials saved';
  }

  const listEl = document.getElementById('deployments-list');
  const emptyEl = document.getElementById('empty-state');

  if (state.deployments.length === 0) {
    listEl.style.display = 'none';
    emptyEl.style.display = '';
    return;
  }

  emptyEl.style.display = 'none';
  listEl.style.display = '';

  listEl.innerHTML = state.deployments.map(d => {
    const date = new Date(d.createdAt).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });
    const updatedDate = d.updatedAt ? new Date(d.updatedAt).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
    }) : null;
    const dirBasename = d.directoryPath ? d.directoryPath.split('/').pop() || d.directoryPath : 'Unknown';
    const display = getStatusDisplay(d.id);
    const s = state.distStatuses[d.id];
    const isFullyDisabled = s && !s.loading && !s.error && !s.enabled && s.status === 'Deployed';
    const hasDomain = d.customDomains && d.customDomains.length > 0;
    const hasPendingDomain = d.pendingDomain && d.pendingDomain.certificateArn;
    const isLive = display.cssClass === 'status-live';
    const isDeploying = display.cssClass === 'status-deploying';
    const canManageDomain = isLive || isDeploying;

    return `
      <div class="deployment-card" data-id="${d.id}">
        <div class="deployment-card-header">
          <div class="deployment-name">${escapeHtml(d.projectName)}</div>
          <div class="deployment-header-right">
            <span class="cf-status-badge ${display.cssClass}">${display.label}</span>
            <span class="deployment-date">${date}</span>
          </div>
        </div>
        <div class="deployment-card-body">
          ${hasDomain ? `<div class="deployment-info-row">
            <span class="info-label">Domain</span>
            <a class="info-value url-value url-link" href="#" data-open-url="https://${escapeHtml(d.customDomains[0].domain)}">${escapeHtml(d.customDomains[0].domain)}</a>
          </div>` : ''}
          <div class="deployment-info-row">
            <span class="info-label">CloudFront</span>
            <a class="info-value url-value url-link" href="#" data-open-url="${escapeHtml(d.cloudFrontUrl)}">${escapeHtml(d.cloudFrontUrl)}</a>
          </div>
          <div class="deployment-info-row">
            <span class="info-label">S3 URL</span>
            <a class="info-value url-value url-link" href="#" data-open-url="${escapeHtml(d.s3WebsiteUrl)}">${escapeHtml(d.s3WebsiteUrl)}</a>
          </div>
          <div class="deployment-info-row">
            <span class="info-label">Bucket</span>
            <span class="info-value mono">${escapeHtml(d.bucketName)}</span>
          </div>
          <div class="deployment-info-row">
            <span class="info-label">Region</span>
            <span class="info-value">${escapeHtml(d.region)}</span>
          </div>
          <div class="deployment-info-row">
            <span class="info-label">Directory</span>
            <span class="info-value mono" title="${escapeHtml(d.directoryPath)}">${escapeHtml(dirBasename)}</span>
          </div>
          ${updatedDate ? `<div class="deployment-info-row"><span class="info-label">Updated</span><span class="info-value">${updatedDate}</span></div>` : ''}
        </div>
        <div class="deployment-card-actions">
          <div class="deploy-dropdown">
            <button class="btn-action btn-deploy" data-action="toggle-deploy" data-id="${d.id}">Deploy ▾</button>
            <div class="deploy-menu" id="deploy-menu-${d.id}">
              <button class="deploy-option" data-action="redeploy-same" data-id="${d.id}">Deploy Changes</button>
              <button class="deploy-option" data-action="update-new-dir" data-id="${d.id}">Change Deployment Directory</button>
            </div>
          </div>
          <button class="btn-action btn-domain" data-action="add-domain" data-id="${d.id}" ${hasDomain || hasPendingDomain || !canManageDomain ? 'style="display:none;"' : ''}>Add Domain</button>
          <button class="btn-action btn-domain" data-action="resume-domain" data-id="${d.id}" ${!hasPendingDomain ? 'style="display:none;"' : ''}>Resume Domain Setup</button>
          <button class="btn-action btn-cancel-domain" data-action="cancel-domain-setup-card" data-id="${d.id}" ${!hasPendingDomain ? 'style="display:none;"' : ''}>Cancel Domain</button>
          <button class="btn-action btn-cancel-domain" data-action="remove-domain" data-id="${d.id}" ${!hasDomain ? 'style="display:none;"' : ''}>Remove Domain</button>
          <button class="btn-action btn-disable" data-action="disable-distribution" data-id="${d.id}" ${!display.canDisable ? 'disabled' : ''} ${isFullyDisabled ? 'style="display:none;"' : ''}>Disable</button>
          <button class="btn-action btn-delete" data-action="delete-deployment" data-id="${d.id}" ${!display.canDelete ? 'disabled' : ''}>Delete</button>
          <div class="open-in-dropdown">
            <button class="btn-action btn-open-in" data-action="toggle-open-in" data-id="${d.id}">Open In ▾</button>
            <div class="open-in-menu" id="open-in-menu-${d.id}">
              <button class="open-in-option" data-action="open-in" data-app="finder" data-id="${d.id}">Finder</button>
              <button class="open-in-option" data-action="open-in" data-app="vscode" data-id="${d.id}">VS Code</button>
              <button class="open-in-option" data-action="open-in" data-app="cursor" data-id="${d.id}">Cursor</button>
              <button class="open-in-option" data-action="open-in" data-app="claude-code" data-id="${d.id}">Claude Code</button>
            </div>
          </div>
          <button class="btn-action btn-remove" data-action="remove-deployment" data-id="${d.id}" ${!display.canRemove ? 'style="display:none;"' : ''}>Remove from App</button>
        </div>
      </div>
    `;
  }).join('');
}

function toggleDeployMenu(id) {
  // Close all other menus first
  document.querySelectorAll('.deploy-menu.show').forEach(menu => {
    if (menu.id !== `deploy-menu-${id}`) menu.classList.remove('show');
  });
  document.querySelectorAll('.open-in-menu.show').forEach(menu => menu.classList.remove('show'));
  const menu = document.getElementById(`deploy-menu-${id}`);
  if (!menu) return;
  const isOpen = menu.classList.toggle('show');
  if (isOpen) {
    const btn = menu.closest('.deploy-dropdown').querySelector('[data-action="toggle-deploy"]');
    const rect = btn.getBoundingClientRect();
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.top - menu.offsetHeight - 6}px`;
  }
}

function toggleOpenInMenu(id) {
  // Close all other menus first
  document.querySelectorAll('.open-in-menu.show').forEach(menu => {
    if (menu.id !== `open-in-menu-${id}`) menu.classList.remove('show');
  });
  document.querySelectorAll('.deploy-menu.show').forEach(menu => menu.classList.remove('show'));
  const menu = document.getElementById(`open-in-menu-${id}`);
  if (!menu) return;
  const isOpen = menu.classList.toggle('show');
  if (isOpen) {
    const btn = menu.closest('.open-in-dropdown').querySelector('[data-action="toggle-open-in"]');
    const rect = btn.getBoundingClientRect();
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.top - menu.offsetHeight - 6}px`;
  }
}

function handleOpenIn(app, id) {
  const deployment = state.deployments.find(d => d.id === id);
  if (!deployment || !deployment.directoryPath) return;
  window.api.openInApp({ app, directoryPath: deployment.directoryPath });
  // Close menu
  const menu = document.getElementById(`open-in-menu-${id}`);
  if (menu) menu.classList.remove('show');
}

// Close dropdown menus when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.open-in-dropdown')) {
    document.querySelectorAll('.open-in-menu.show').forEach(menu => menu.classList.remove('show'));
  }
  if (!e.target.closest('.deploy-dropdown')) {
    document.querySelectorAll('.deploy-menu.show').forEach(menu => menu.classList.remove('show'));
  }
}, true);

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ========================================
// Disable Distribution
// ========================================

async function handleDisableDistribution(deploymentId) {
  const deployment = state.deployments.find(d => d.id === deploymentId);
  if (!deployment) return;

  // Update UI immediately
  const card = document.querySelector(`.deployment-card[data-id="${deploymentId}"]`);
  const disableBtn = card?.querySelector('[data-action="disable-distribution"]');
  if (disableBtn) {
    disableBtn.disabled = true;
    disableBtn.textContent = 'Disabling...';
  }

  const result = await window.api.disableDistribution({
    accessKeyId: state.accessKeyId,
    secretAccessKey: state.secretAccessKey,
    distributionId: deployment.distributionId
  });

  if (result.success) {
    // Refresh status
    await fetchDistributionStatus(deploymentId);
    startStatusPollingIfNeeded();
  } else {
    // Restore button
    if (disableBtn) {
      disableBtn.disabled = false;
      disableBtn.textContent = 'Disable';
    }
    // Could show an error, but for now just log
    console.error('Failed to disable distribution:', result.error);
  }
}

// ========================================
// Wizard Step Navigation
// ========================================

function goToStep(step) {
  if (step < 1 || step > state.totalSteps) return;
  if (state.deploying && step !== 5) return;

  const currentPanel = document.getElementById(`step-${state.currentStep}`);
  const targetPanel = document.getElementById(`step-${step}`);

  currentPanel.classList.remove('active');
  targetPanel.classList.add('active');

  document.querySelectorAll('.step-dot').forEach((dot, i) => {
    const dotStep = i + 1;
    dot.classList.remove('active', 'completed');
    if (dotStep < step) dot.classList.add('completed');
    if (dotStep === step) dot.classList.add('active');
  });

  const fill = document.getElementById('progress-fill');
  const pct = ((step - 1) / (state.totalSteps - 1)) * 100;
  fill.style.width = `${pct}%`;

  state.currentStep = step;

  if (step === 4) populateReview();
}

function nextStep() {
  if (!validateStep(state.currentStep)) return;
  saveStepData(state.currentStep);

  // Save credentials when leaving step 1
  if (state.currentStep === 1) {
    window.api.saveCredentials({
      accessKeyId: state.accessKeyId,
      secretAccessKey: state.secretAccessKey,
      region: state.region
    });
    state.hasCredentials = true;
    document.querySelectorAll('.wizard-dashboard-btn').forEach(el => el.style.display = '');
  }

  goToStep(state.currentStep + 1);
}

function prevStep() {
  goToStep(state.currentStep - 1);
}

// ========================================
// Validation
// ========================================

function validateStep(step) {
  clearError(step);

  switch (step) {
    case 1: {
      const accessKey = document.getElementById('access-key').value.trim();
      const secretKey = document.getElementById('secret-key').value.trim();
      if (!accessKey) return showError(1, 'Access Key ID is required.');
      if (!secretKey) return showError(1, 'Secret Access Key is required.');
      if (accessKey.length < 16) return showError(1, 'Access Key ID appears too short.');
      return true;
    }
    case 2: {
      const name = document.getElementById('project-name').value.trim();
      if (!name) return showError(2, 'Project name is required.');
      const sanitized = sanitize(name);
      if (sanitized.length < 3) return showError(2, 'Project name must be at least 3 characters after sanitization.');
      if (sanitized.length > 40) return showError(2, 'Project name must be 40 characters or fewer.');
      return true;
    }
    case 3: {
      if (!state.directoryPath) return showError(3, 'Please select a directory.');
      return true;
    }
    default:
      return true;
  }
}

function showError(step, msg) {
  const el = document.getElementById(`error-${step}`);
  if (el) el.textContent = msg;
  return false;
}

function clearError(step) {
  const el = document.getElementById(`error-${step}`);
  if (el) el.textContent = '';
}

// ========================================
// Data
// ========================================

function saveStepData(step) {
  switch (step) {
    case 1:
      state.accessKeyId = document.getElementById('access-key').value.trim();
      state.secretAccessKey = document.getElementById('secret-key').value.trim();
      state.region = document.getElementById('region').value;
      break;
    case 2:
      state.projectName = document.getElementById('project-name').value.trim();
      state.bucketName = sanitize(state.projectName) + '-xxxxxxxx';
      break;
  }
}

function sanitize(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ========================================
// Directory Selection
// ========================================

async function handleSelectDirectory() {
  const result = await window.api.selectDirectory();
  if (!result) return;

  state.directoryPath = result.path;
  state.fileCount = result.fileCount;

  document.getElementById('directory-picker').style.display = 'none';
  document.getElementById('selected-directory').style.display = 'flex';
  document.getElementById('dir-path').textContent = result.path;
  document.getElementById('dir-files').textContent = `${result.fileCount} file${result.fileCount !== 1 ? 's' : ''} found`;
}

// ========================================
// Review
// ========================================

function populateReview() {
  const regionSelect = document.getElementById('region');
  const regionText = regionSelect.options[regionSelect.selectedIndex].text;

  document.getElementById('review-region').textContent = regionText;
  document.getElementById('review-project').textContent = state.projectName;
  document.getElementById('review-bucket').textContent = sanitize(state.projectName) + '-xxxxxxxx';
  document.getElementById('review-directory').textContent = state.directoryPath;
  document.getElementById('review-files').textContent = `${state.fileCount} file${state.fileCount !== 1 ? 's' : ''}`;
}

// ========================================
// New Deployment
// ========================================

async function handleDeploy() {
  state.deploying = true;
  goToStep(5);

  resetDeploySteps();
  document.getElementById('deploy-result').style.display = 'none';
  document.getElementById('deploy-error').style.display = 'none';
  document.getElementById('deploy-abort-nav').style.display = '';
  document.getElementById('deploy-subtitle').textContent = 'Setting up your website...';

  window.api.onDeployProgress((progress) => {
    updateDeployStep(progress);
  });

  const result = await window.api.deploy({
    accessKeyId: state.accessKeyId,
    secretAccessKey: state.secretAccessKey,
    region: state.region,
    projectName: state.projectName,
    directoryPath: state.directoryPath
  });

  if (result.success) {
    document.getElementById('deploy-subtitle').textContent = 'Your website is live!';
    document.getElementById('cloudfront-url').value = result.cloudFrontUrl;
    document.getElementById('s3-url').value = result.s3WebsiteUrl;
    document.getElementById('deploy-result').style.display = 'block';
    document.getElementById('deploy-abort-nav').style.display = 'none';

    // Save deployment record
    const deployment = {
      id: Date.now().toString() + Math.random().toString(36).slice(2, 8),
      projectName: state.projectName,
      bucketName: result.bucketName,
      distributionId: result.distributionId,
      cloudFrontUrl: result.cloudFrontUrl,
      s3WebsiteUrl: result.s3WebsiteUrl,
      region: state.region,
      directoryPath: state.directoryPath,
      createdAt: new Date().toISOString(),
      updatedAt: null
    };
    await window.api.saveDeployment(deployment);
    state.deployments.unshift(deployment);
  } else {
    document.getElementById('deploy-subtitle').textContent = 'Something went wrong.';
    document.getElementById('deploy-error-message').textContent = result.error;
    document.getElementById('deploy-error').style.display = 'block';
    document.getElementById('deploy-abort-nav').style.display = 'none';
  }

  state.deploying = false;
}

function resetDeploySteps() {
  document.querySelectorAll('#view-wizard .deploy-step').forEach(el => {
    el.classList.remove('active', 'done');
    const icon = el.querySelector('.deploy-step-icon');
    icon.className = 'deploy-step-icon pending';
  });
  document.querySelectorAll('#view-wizard .deploy-step-message').forEach(el => {
    el.textContent = '';
  });
  document.getElementById('upload-progress').style.display = 'none';
  document.getElementById('upload-progress-fill').style.width = '0%';
}

function updateDeployStep(progress) {
  const { step, status, message, current, total } = progress;

  if (step === 'complete') return;

  const deployStep = document.querySelector(`#view-wizard [data-deploy="${step}"]`);
  if (!deployStep) return;

  const allSteps = document.querySelectorAll('#view-wizard .deploy-step');
  let found = false;
  allSteps.forEach(s => {
    if (s === deployStep) {
      found = true;
      return;
    }
    if (!found) {
      s.classList.add('done');
      s.classList.remove('active');
      const icon = s.querySelector('.deploy-step-icon');
      if (icon.classList.contains('pending') || icon.classList.contains('in-progress')) {
        icon.className = 'deploy-step-icon complete';
      }
    }
  });

  const icon = deployStep.querySelector('.deploy-step-icon');
  icon.className = `deploy-step-icon ${status}`;
  deployStep.classList.toggle('active', status === 'in-progress');
  deployStep.classList.toggle('done', status === 'complete');

  const msgEl = document.getElementById(`msg-${step}`);
  if (msgEl) msgEl.textContent = message;

  if (step === 'uploading' && current !== undefined && total !== undefined) {
    const uploadProgress = document.getElementById('upload-progress');
    const uploadFill = document.getElementById('upload-progress-fill');
    uploadProgress.style.display = 'block';
    uploadFill.style.width = `${(current / total) * 100}%`;
  }
}

// ========================================
// Update Deployment
// ========================================

async function handleUpdateDeployment(deploymentId, newDirectory) {
  const deployment = state.deployments.find(d => d.id === deploymentId);
  if (!deployment) return;

  let directoryPath = deployment.directoryPath;

  if (newDirectory) {
    const result = await window.api.selectDirectory();
    if (!result) return;
    directoryPath = result.path;
  }

  state.operationRunning = true;
  showView('operation');

  document.getElementById('operation-title').textContent = 'Updating Deployment';
  document.getElementById('operation-subtitle').textContent = `Updating ${deployment.projectName}...`;
  document.getElementById('operation-result').style.display = 'none';
  document.getElementById('operation-error').style.display = 'none';

  // Build operation steps
  const stepsContainer = document.getElementById('operation-steps');
  stepsContainer.innerHTML = buildOperationStepHTML('uploading', 'Upload Files')
    + buildOperationStepHTML('invalidating', 'Invalidate Cache');

  document.getElementById('op-upload-progress').style.display = 'none';
  document.getElementById('op-upload-progress-fill').style.width = '0%';

  window.api.onOperationProgress((progress) => {
    updateOperationStep(progress);
  });

  const result = await window.api.updateDeployment({
    accessKeyId: state.accessKeyId,
    secretAccessKey: state.secretAccessKey,
    region: deployment.region,
    bucketName: deployment.bucketName,
    distributionId: deployment.distributionId,
    directoryPath: directoryPath
  });

  if (result.success) {
    document.getElementById('operation-subtitle').textContent = 'Update complete!';
    document.getElementById('operation-success-title').textContent = 'Update Complete!';
    document.getElementById('operation-success-message').textContent =
      'Your files have been uploaded and a cache invalidation has been created. Changes will propagate in 5-15 minutes.';
    document.getElementById('operation-result').style.display = 'block';

    // Update the deployment record
    const idx = state.deployments.findIndex(d => d.id === deploymentId);
    if (idx >= 0) {
      state.deployments[idx].directoryPath = directoryPath;
      state.deployments[idx].updatedAt = new Date().toISOString();
    }
    // Persist updated record (remove old and re-save full list)
    await window.api.removeDeploymentRecord(deploymentId);
    await window.api.saveDeployment(state.deployments[idx]);
    // Re-fetch to keep in sync
    state.deployments = await window.api.getDeployments();
  } else {
    document.getElementById('operation-subtitle').textContent = 'Update failed.';
    document.getElementById('operation-error-message').textContent = result.error;
    document.getElementById('operation-error').style.display = 'block';
  }

  state.operationRunning = false;
}

// ========================================
// Delete Deployment
// ========================================

function showDeleteConfirmation(deploymentId) {
  const deployment = state.deployments.find(d => d.id === deploymentId);
  if (!deployment) return;

  // Double-check that distribution is ready for deletion
  const display = getStatusDisplay(deploymentId);
  if (!display.canDelete) return;

  state.pendingDeleteId = deploymentId;
  document.getElementById('delete-modal-name').textContent = deployment.projectName;
  document.getElementById('delete-modal').style.display = 'flex';
}

function hideDeleteModal() {
  document.getElementById('delete-modal').style.display = 'none';
  state.pendingDeleteId = null;
}

async function handleDeleteDeployment() {
  const deploymentId = state.pendingDeleteId;
  const deployment = state.deployments.find(d => d.id === deploymentId);
  if (!deployment) return;

  hideDeleteModal();
  state.operationRunning = true;
  showView('operation');

  document.getElementById('operation-title').textContent = 'Deleting Deployment';
  document.getElementById('operation-subtitle').textContent = `Removing ${deployment.projectName}...`;
  document.getElementById('operation-result').style.display = 'none';
  document.getElementById('operation-error').style.display = 'none';

  const hasDomain = deployment.customDomains && deployment.customDomains.length > 0;

  const stepsContainer = document.getElementById('operation-steps');
  stepsContainer.innerHTML =
    (hasDomain ? buildOperationStepHTML('removing-domain', 'Remove Custom Domain') : '')
    + buildOperationStepHTML('deleting-objects', 'Delete Bucket Objects')
    + buildOperationStepHTML('deleting-bucket', 'Delete S3 Bucket')
    + buildOperationStepHTML('disabling-distribution', 'Check Distribution Status')
    + buildOperationStepHTML('waiting-distribution', 'Wait for Distribution')
    + buildOperationStepHTML('deleting-distribution', 'Delete CloudFront Distribution');

  document.getElementById('op-upload-progress').style.display = 'none';

  window.api.onOperationProgress((progress) => {
    updateOperationStep(progress);
  });

  const result = await window.api.deleteDeployment({
    deploymentId: deployment.id,
    accessKeyId: state.accessKeyId,
    secretAccessKey: state.secretAccessKey,
    region: deployment.region,
    bucketName: deployment.bucketName,
    distributionId: deployment.distributionId,
    customDomains: deployment.customDomains || [],
    pendingDomain: deployment.pendingDomain || null
  });

  if (result.success) {
    document.getElementById('operation-subtitle').textContent = 'Deployment deleted.';
    document.getElementById('operation-success-title').textContent = 'Deployment Deleted';
    document.getElementById('operation-success-message').textContent =
      'All AWS resources have been successfully removed.';
    document.getElementById('operation-result').style.display = 'block';

    // Remove from local state
    state.deployments = state.deployments.filter(d => d.id !== deploymentId);
    delete state.distStatuses[deploymentId];
  } else {
    document.getElementById('operation-subtitle').textContent = 'Deletion failed.';
    document.getElementById('operation-error-message').textContent = result.error;
    document.getElementById('operation-error').style.display = 'block';
  }

  state.operationRunning = false;
}

// ========================================
// Remove Orphaned Deployment
// ========================================

function showRemoveConfirmation(deploymentId) {
  const deployment = state.deployments.find(d => d.id === deploymentId);
  if (!deployment) return;

  state.pendingDeleteId = deploymentId;
  document.getElementById('remove-modal-name').textContent = deployment.projectName;
  document.getElementById('remove-modal').style.display = 'flex';
}

function hideRemoveModal() {
  document.getElementById('remove-modal').style.display = 'none';
  state.pendingDeleteId = null;
}

async function handleRemoveDeployment() {
  const deploymentId = state.pendingDeleteId;
  if (!deploymentId) return;

  hideRemoveModal();

  await window.api.removeDeploymentRecord(deploymentId);
  state.deployments = state.deployments.filter(d => d.id !== deploymentId);
  delete state.distStatuses[deploymentId];
  renderDashboard();
}

// ========================================
// Custom Domain
// ========================================

function showDomainModal(deploymentId) {
  const deployment = state.deployments.find(d => d.id === deploymentId);
  if (!deployment) return;

  state.domainSetup = {
    deploymentId,
    domain: '',
    certificateArn: '',
    validationRecords: [],
    step: 1
  };

  // Reset UI
  document.getElementById('domain-input').value = '';
  document.getElementById('domain-error').textContent = '';
  document.getElementById('domain-validate-error').textContent = '';
  document.getElementById('domain-apply-error').textContent = '';
  document.getElementById('domain-validate-status').style.display = 'none';
  document.getElementById('domain-records-loading').style.display = '';
  document.getElementById('domain-records-ready').style.display = 'none';
  document.getElementById('btn-check-cert').textContent = 'Check Status';
  document.getElementById('btn-check-cert').disabled = true;
  document.getElementById('btn-domain-continue').disabled = false;
  document.getElementById('btn-domain-continue').textContent = 'Continue';

  // Check if resuming a pending domain setup
  if (deployment.pendingDomain) {
    state.domainSetup.domain = deployment.pendingDomain.domain;
    state.domainSetup.certificateArn = deployment.pendingDomain.certificateArn;
    showDomainStep(2);
    document.getElementById('domain-modal').style.display = 'flex';
    pollForValidationRecords();
    return;
  }

  showDomainStep(1);
  document.getElementById('domain-modal').style.display = 'flex';
}

function hideDomainModal() {
  document.getElementById('domain-modal').style.display = 'none';
  state.domainSetup = { deploymentId: null, domain: '', certificateArn: '', validationRecords: [], step: 1 };
}

function showDomainStep(step) {
  for (let i = 1; i <= 4; i++) {
    document.getElementById(`domain-step-${i}`).style.display = i === step ? '' : 'none';
  }
  state.domainSetup.step = step;
}

async function handleRequestCertificate() {
  let domain = document.getElementById('domain-input').value.trim();

  // Strip protocol if user accidentally included it
  domain = domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');

  if (!domain || !domain.includes('.') || domain.includes(' ')) {
    document.getElementById('domain-error').textContent = 'Please enter a valid domain name (e.g., www.example.com).';
    return;
  }

  state.domainSetup.domain = domain;
  document.getElementById('domain-error').textContent = '';

  const btn = document.getElementById('btn-domain-continue');
  btn.disabled = true;
  btn.textContent = 'Requesting...';

  const result = await window.api.requestCertificate({
    accessKeyId: state.accessKeyId,
    secretAccessKey: state.secretAccessKey,
    domain
  });

  if (!result.success) {
    document.getElementById('domain-error').textContent = result.error;
    btn.disabled = false;
    btn.textContent = 'Continue';
    return;
  }

  state.domainSetup.certificateArn = result.certificateArn;

  // Persist pending domain to the deployment record so it survives modal close
  const deployment = state.deployments.find(d => d.id === state.domainSetup.deploymentId);
  if (deployment) {
    const pendingDomain = { domain, certificateArn: result.certificateArn };
    await window.api.updateDeploymentRecord({ id: deployment.id, updates: { pendingDomain } });
    const idx = state.deployments.findIndex(d => d.id === deployment.id);
    if (idx >= 0) state.deployments[idx].pendingDomain = pendingDomain;
  }

  // Show step 2 with loading spinner, then poll for records
  showDomainStep(2);
  document.getElementById('domain-records-loading').style.display = '';
  document.getElementById('domain-records-ready').style.display = 'none';
  document.getElementById('btn-check-cert').disabled = true;
  pollForValidationRecords();
}

async function pollForValidationRecords() {
  const maxAttempts = 20; // ~20 seconds max
  for (let i = 0; i < maxAttempts; i++) {
    const result = await window.api.checkCertificateStatus({
      accessKeyId: state.accessKeyId,
      secretAccessKey: state.secretAccessKey,
      certificateArn: state.domainSetup.certificateArn
    });

    if (!result.success) {
      // If the modal was closed while polling, stop
      if (!state.domainSetup.certificateArn) return;
      continue;
    }

    // Check if any record has actual name/value populated
    const readyRecords = result.validationRecords.filter(r => r.name && r.value);
    if (readyRecords.length > 0) {
      state.domainSetup.validationRecords = readyRecords;
      renderDnsRecords(readyRecords);
      document.getElementById('domain-records-loading').style.display = 'none';
      document.getElementById('domain-records-ready').style.display = '';
      document.getElementById('btn-check-cert').disabled = false;
      return;
    }

    // Wait 1 second before retrying
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Stop if modal was closed
    if (!state.domainSetup.certificateArn) return;
  }

  // If we get here, records never showed up — show what we have anyway
  document.getElementById('domain-records-loading').style.display = 'none';
  document.getElementById('domain-records-ready').style.display = '';
  document.getElementById('domain-validate-error').textContent = 'Verification record is taking longer than expected. Please try again in a moment.';
  document.getElementById('btn-check-cert').disabled = false;
  document.getElementById('btn-check-cert').textContent = 'Retry';
}

function renderDnsRecords(records) {
  const container = document.getElementById('domain-dns-records');
  container.innerHTML = records.map(r => `
    <div class="dns-record-row">
      <span class="dns-record-label">Type</span>
      <span class="dns-record-value">CNAME</span>
    </div>
    <div class="dns-record-row">
      <span class="dns-record-label">Name</span>
      <span class="dns-record-value">${escapeHtml(r.name)}</span>
    </div>
    <div class="dns-record-row">
      <span class="dns-record-label">Value</span>
      <span class="dns-record-value">${escapeHtml(r.value)}</span>
    </div>
  `).join('');
}

async function handleCheckCertificateStatus() {
  const btn = document.getElementById('btn-check-cert');
  const statusEl = document.getElementById('domain-validate-status');
  const errorEl = document.getElementById('domain-validate-error');

  btn.disabled = true;
  btn.textContent = 'Checking...';
  errorEl.textContent = '';

  const result = await window.api.checkCertificateStatus({
    accessKeyId: state.accessKeyId,
    secretAccessKey: state.secretAccessKey,
    certificateArn: state.domainSetup.certificateArn
  });

  if (!result.success) {
    errorEl.textContent = result.error;
    btn.disabled = false;
    btn.textContent = 'Check Again';
    return;
  }

  if (result.status === 'ISSUED') {
    statusEl.style.display = 'none';
    await handleApplyDomain();
    return;
  }

  if (result.status === 'FAILED') {
    errorEl.textContent = 'Certificate validation failed. Please check your DNS records and try again.';
    btn.disabled = false;
    btn.textContent = 'Check Again';
    return;
  }

  // Still pending
  statusEl.style.display = 'block';
  statusEl.className = 'domain-validate-status pending';
  statusEl.textContent = 'Not verified yet — DNS changes can take 15–30 minutes to propagate. Come back and check again shortly.';
  btn.disabled = false;
  btn.textContent = 'Check Again';
}

async function handleApplyDomain() {
  showDomainStep(3);

  const deployment = state.deployments.find(d => d.id === state.domainSetup.deploymentId);
  if (!deployment) return;

  const result = await window.api.addCustomDomain({
    accessKeyId: state.accessKeyId,
    secretAccessKey: state.secretAccessKey,
    distributionId: deployment.distributionId,
    domain: state.domainSetup.domain,
    certificateArn: state.domainSetup.certificateArn
  });

  if (!result.success) {
    document.getElementById('domain-apply-error').textContent = result.error;
    return;
  }

  // Save to deployment record — set customDomains and clear pendingDomain
  const customDomains = [{ domain: state.domainSetup.domain, certificateArn: state.domainSetup.certificateArn, status: 'active' }];
  await window.api.updateDeploymentRecord({ id: deployment.id, updates: { customDomains, pendingDomain: null } });

  // Update local state
  const idx = state.deployments.findIndex(d => d.id === deployment.id);
  if (idx >= 0) {
    state.deployments[idx].customDomains = customDomains;
    delete state.deployments[idx].pendingDomain;
  }

  // Show final CNAME step
  const cfDomain = deployment.cloudFrontUrl.replace('https://', '');
  document.getElementById('domain-final-cname').innerHTML = `
    <div class="dns-record-row">
      <span class="dns-record-label">Type</span>
      <span class="dns-record-value">CNAME</span>
    </div>
    <div class="dns-record-row">
      <span class="dns-record-label">Name</span>
      <span class="dns-record-value">${escapeHtml(state.domainSetup.domain)}</span>
    </div>
    <div class="dns-record-row">
      <span class="dns-record-label">Value</span>
      <span class="dns-record-value">${escapeHtml(cfDomain)}</span>
    </div>
  `;

  showDomainStep(4);
}

function handleDomainDone() {
  hideDomainModal();
  renderDashboard();
}

async function handleCancelDomainSetup() {
  const deploymentId = state.domainSetup.deploymentId;
  const certificateArn = state.domainSetup.certificateArn;
  const deployment = state.deployments.find(d => d.id === deploymentId);

  // If no cert in current session, check the persisted pending domain
  const arn = certificateArn || (deployment && deployment.pendingDomain && deployment.pendingDomain.certificateArn);

  if (arn) {
    // Delete the certificate from AWS
    try {
      await window.api.removeCustomDomain({
        accessKeyId: state.accessKeyId,
        secretAccessKey: state.secretAccessKey,
        distributionId: deployment ? deployment.distributionId : '',
        certificateArn: arn
      });
    } catch { /* best effort */ }
  }

  // Clear pendingDomain from the deployment record
  if (deployment) {
    await window.api.updateDeploymentRecord({ id: deployment.id, updates: { pendingDomain: null } });
    const idx = state.deployments.findIndex(d => d.id === deployment.id);
    if (idx >= 0) delete state.deployments[idx].pendingDomain;
  }

  hideDomainModal();
  renderDashboard();
}

// ========================================
// Remove Custom Domain
// ========================================

function showRemoveDomainConfirmation(deploymentId) {
  const deployment = state.deployments.find(d => d.id === deploymentId);
  if (!deployment || !deployment.customDomains || deployment.customDomains.length === 0) return;

  state.pendingRemoveDomainId = deploymentId;
  document.getElementById('remove-domain-modal-name').textContent = deployment.customDomains[0].domain;
  document.getElementById('remove-domain-modal').style.display = 'flex';
}

function hideRemoveDomainModal() {
  document.getElementById('remove-domain-modal').style.display = 'none';
  state.pendingRemoveDomainId = null;
}

async function handleRemoveDomain() {
  const deploymentId = state.pendingRemoveDomainId;
  const deployment = state.deployments.find(d => d.id === deploymentId);
  if (!deployment || !deployment.customDomains || deployment.customDomains.length === 0) return;

  const cd = deployment.customDomains[0];

  // Disable buttons in the modal while working
  const confirmBtn = document.querySelector('#remove-domain-modal [data-action="confirm-remove-domain"]');
  const cancelBtn = document.querySelector('#remove-domain-modal [data-action="cancel-remove-domain"]');
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Removing...'; }
  if (cancelBtn) cancelBtn.disabled = true;

  const result = await window.api.removeCustomDomain({
    accessKeyId: state.accessKeyId,
    secretAccessKey: state.secretAccessKey,
    distributionId: deployment.distributionId,
    certificateArn: cd.certificateArn
  });

  if (result.success) {
    await window.api.updateDeploymentRecord({ id: deployment.id, updates: { customDomains: null } });
    const idx = state.deployments.findIndex(d => d.id === deploymentId);
    if (idx >= 0) delete state.deployments[idx].customDomains;
    hideRemoveDomainModal();
    renderDashboard();
  } else {
    // Restore buttons and show error in the modal
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Remove Domain'; }
    if (cancelBtn) cancelBtn.disabled = false;
    const warningEl = document.querySelector('#remove-domain-modal .modal-warning');
    if (warningEl) warningEl.textContent = `Failed: ${result.error}`;
  }
}

// ========================================
// Operation Step Helpers
// ========================================

function buildOperationStepHTML(stepId, label) {
  return `
    <div class="deploy-step" data-op-step="${stepId}">
      <div class="deploy-step-icon pending">
        <div class="spinner"></div>
        <svg class="icon-check" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
        <svg class="icon-error" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </div>
      <div class="deploy-step-text">
        <div class="deploy-step-label">${label}</div>
        <div class="deploy-step-message" id="op-msg-${stepId}"></div>
      </div>
    </div>
  `;
}

function updateOperationStep(progress) {
  const { step, status, message, current, total } = progress;

  if (step === 'complete') return;

  const opStep = document.querySelector(`[data-op-step="${step}"]`);
  if (!opStep) return;

  // Mark all previous steps as done
  const allSteps = document.querySelectorAll('#operation-steps .deploy-step');
  let found = false;
  allSteps.forEach(s => {
    if (s === opStep) {
      found = true;
      return;
    }
    if (!found) {
      s.classList.add('done');
      s.classList.remove('active');
      const icon = s.querySelector('.deploy-step-icon');
      if (icon.classList.contains('pending') || icon.classList.contains('in-progress')) {
        icon.className = 'deploy-step-icon complete';
      }
    }
  });

  const icon = opStep.querySelector('.deploy-step-icon');
  icon.className = `deploy-step-icon ${status}`;
  opStep.classList.toggle('active', status === 'in-progress');
  opStep.classList.toggle('done', status === 'complete');

  const msgEl = document.getElementById(`op-msg-${step}`);
  if (msgEl) msgEl.textContent = message;

  // Upload progress bar for operation view
  if (step === 'uploading' && current !== undefined && total !== undefined) {
    const uploadProgress = document.getElementById('op-upload-progress');
    const uploadFill = document.getElementById('op-upload-progress-fill');
    uploadProgress.style.display = 'block';
    uploadFill.style.width = `${(current / total) * 100}%`;
  }
}

// ========================================
// Utilities
// ========================================


function resetWizard() {
  state.projectName = '';
  state.directoryPath = '';
  state.fileCount = 0;
  state.bucketName = '';
  state.deploying = false;

  document.getElementById('project-name').value = '';
  document.getElementById('bucket-name-preview').textContent = '\u2014';
  document.getElementById('directory-picker').style.display = '';
  document.getElementById('selected-directory').style.display = 'none';

  // Remove active from all step panels to avoid ghost panels
  document.querySelectorAll('.step-panel').forEach(p => p.classList.remove('active'));
  state.currentStep = 1;
  document.getElementById('step-1').classList.add('active');

  // Reset step dots and progress bar
  document.querySelectorAll('.step-dot').forEach((dot, i) => {
    dot.classList.remove('active', 'completed');
    if (i === 0) dot.classList.add('active');
  });
  document.getElementById('progress-fill').style.width = '0%';
}

// ========================================
// Live Preview for Project Name
// ========================================

document.getElementById('project-name').addEventListener('input', (e) => {
  const raw = e.target.value;
  const sanitized = sanitize(raw);
  const preview = document.getElementById('bucket-name-preview');

  if (sanitized.length >= 3) {
    preview.textContent = `${sanitized}-xxxxxxxx`;
    preview.style.color = '';
  } else if (raw.length > 0) {
    preview.textContent = 'Name too short...';
    preview.style.color = 'var(--warning)';
  } else {
    preview.textContent = '\u2014';
    preview.style.color = '';
  }
});

// ========================================
// Event Delegation
// ========================================

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action]');

  // Handle URL links (dashboard)
  const urlLink = e.target.closest('[data-open-url]');
  if (urlLink) {
    e.preventDefault();
    window.api.openExternal(urlLink.dataset.openUrl);
    return;
  }

  // Handle open buttons (wizard result)
  const openBtn = e.target.closest('[data-open]');
  if (openBtn) {
    const input = document.getElementById(openBtn.dataset.open);
    if (input && input.value) window.api.openExternal(input.value);
    return;
  }

  if (!target) return;

  // Don't handle clicks on disabled buttons
  if (target.disabled) return;

  const action = target.dataset.action;
  const id = target.dataset.id;

  switch (action) {
    // Wizard navigation
    case 'next':
      nextStep();
      break;
    case 'back':
      prevStep();
      break;
    case 'select-dir':
      handleSelectDirectory();
      break;
    case 'deploy':
      handleDeploy();
      break;
    case 'reset':
      resetWizard();
      break;

    // View navigation
    case 'new-deployment':
      resetWizard();
      showView('wizard');
      if (state.hasCredentials) {
        goToStep(2);
      }
      break;
    case 'go-dashboard':
      showView('dashboard');
      break;
    case 'back-to-dashboard':
      showView('dashboard');
      break;
    case 'edit-credentials':
      showView('wizard');
      goToStep(1);
      break;

    // Deployment actions
    case 'toggle-deploy':
      toggleDeployMenu(id);
      break;
    case 'update-new-dir':
      document.querySelectorAll('.deploy-menu.show').forEach(menu => menu.classList.remove('show'));
      handleUpdateDeployment(id, true);
      break;
    case 'redeploy-same':
      document.querySelectorAll('.deploy-menu.show').forEach(menu => menu.classList.remove('show'));
      handleUpdateDeployment(id, false);
      break;
    case 'disable-distribution':
      handleDisableDistribution(id);
      break;
    case 'delete-deployment':
      showDeleteConfirmation(id);
      break;
    case 'confirm-delete':
      handleDeleteDeployment();
      break;
    case 'cancel-delete':
      hideDeleteModal();
      break;
    case 'toggle-open-in':
      toggleOpenInMenu(id);
      break;
    case 'open-in':
      handleOpenIn(target.dataset.app, id);
      break;
    case 'remove-deployment':
      showRemoveConfirmation(id);
      break;
    case 'confirm-remove':
      handleRemoveDeployment();
      break;
    case 'cancel-remove':
      hideRemoveModal();
      break;

    // Custom domain
    case 'add-domain':
      showDomainModal(id);
      break;
    case 'resume-domain':
      showDomainModal(id);
      break;
    case 'cancel-domain':
      hideDomainModal();
      break;
    case 'cancel-domain-setup':
      handleCancelDomainSetup();
      break;
    case 'cancel-domain-setup-card':
      // Cancel from dashboard card — set up state so handleCancelDomainSetup works
      {
        const dep = state.deployments.find(d => d.id === id);
        if (dep && dep.pendingDomain) {
          state.domainSetup.deploymentId = id;
          state.domainSetup.certificateArn = dep.pendingDomain.certificateArn;
        }
        handleCancelDomainSetup();
      }
      break;
    case 'remove-domain':
      showRemoveDomainConfirmation(id);
      break;
    case 'confirm-remove-domain':
      handleRemoveDomain();
      break;
    case 'cancel-remove-domain':
      hideRemoveDomainModal();
      break;
    case 'domain-request-cert':
      handleRequestCertificate();
      break;
    case 'domain-check-status':
      handleCheckCertificateStatus();
      break;
    case 'domain-done':
      handleDomainDone();
      break;
  }
});
