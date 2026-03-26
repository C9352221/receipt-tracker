/**
 * Receipt Tracker PWA — App Logic
 *
 * Handles camera capture, image optimization, upload to Cloudflare Worker,
 * dashboard listing, detail view, and offline queue.
 */

// --- Configuration ---
// UPDATE THIS after deploying the Cloudflare Worker
const API_URL = 'https://receipt-api.alfanoministries.workers.dev';
const API_KEY = 'eef0490c12123e527577f0159051091fa7491f0355ea9d0c422e2a74e10167d3';

// --- State ---
let currentAccount = 'business';
let currentImage = null; // base64 string (no prefix)
let receipts = [];
let currentOffset = 0;
const PAGE_SIZE = 50;

// --- DOM Elements ---
const statusDot = document.getElementById('statusDot');
const cameraInput = document.getElementById('cameraInput');
const previewImg = document.getElementById('previewImg');
const submitBtn = document.getElementById('submitBtn');
const tripSelect = document.getElementById('tripSelect');
const tripNameNew = document.getElementById('tripNameNew');
const receiptList = document.getElementById('receiptList');
const loadMoreBtn = document.getElementById('loadMoreBtn');
const detailBack = document.getElementById('detailBack');
const detailImage = document.getElementById('detailImage');
const detailFields = document.getElementById('detailFields');

// --- Service Worker Registration ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(err => {
    console.warn('SW registration failed:', err);
  });
}

// --- Online/Offline Status ---
function updateStatus() {
  const online = navigator.onLine;
  statusDot.classList.toggle('offline', !online);
  statusDot.title = online ? 'Online' : 'Offline';
}
window.addEventListener('online', updateStatus);
window.addEventListener('offline', updateStatus);
updateStatus();

// --- Tab Navigation ---
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const screen = tab.dataset.screen;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`screen-${screen}`).classList.add('active');

    if (screen === 'dashboard') {
      loadFilterTrips();
      loadReceipts(true);
    }
  });
});

// --- Account Toggle ---
document.querySelectorAll('.account-toggle button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.account-toggle button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentAccount = btn.dataset.account;
  });
});

// --- Trip Name Dropdown ---
async function loadTrips() {
  try {
    const data = await apiCall('GET', '/trips');
    // Remove old dynamic options (keep first two: "No trip" and "New trip")
    while (tripSelect.options.length > 2) {
      tripSelect.remove(2);
    }
    // Insert trip options before the "New trip" option
    const newTripOption = tripSelect.options[1];
    for (const trip of data.trips) {
      const opt = document.createElement('option');
      opt.value = trip.name;
      opt.textContent = `${trip.name} (${trip.receipt_count})`;
      tripSelect.insertBefore(opt, newTripOption);
    }
    // Restore last used trip from localStorage
    const lastTrip = localStorage.getItem('lastTrip');
    if (lastTrip) {
      const match = Array.from(tripSelect.options).find(o => o.value === lastTrip);
      if (match) {
        tripSelect.value = lastTrip;
      }
    }
  } catch (err) {
    console.warn('Failed to load trips:', err);
  }
}

tripSelect.addEventListener('change', () => {
  if (tripSelect.value === '__new__') {
    tripNameNew.style.display = 'block';
    tripNameNew.focus();
  } else {
    tripNameNew.style.display = 'none';
    tripNameNew.value = '';
    if (tripSelect.value) {
      localStorage.setItem('lastTrip', tripSelect.value);
    }
  }
});

function getTripName() {
  if (tripSelect.value === '__new__') {
    return tripNameNew.value.trim() || null;
  }
  return tripSelect.value || null;
}

// Load trips on startup
loadTrips();

// --- Camera / Image Handling ---
cameraInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const optimized = await optimizeImage(file);
    currentImage = optimized;
    previewImg.src = `data:image/jpeg;base64,${optimized}`;
    previewImg.classList.add('visible');
    submitBtn.disabled = false;
  } catch (err) {
    showToast('Failed to process image', 'error');
    console.error('Image optimization error:', err);
  }
});

/**
 * Resize image to max 1920px and compress to ~85% JPEG quality.
 * Returns base64 string (no data: prefix).
 */
function optimizeImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let { width, height } = img;
        const MAX = 1920;

        if (width > MAX || height > MAX) {
          if (width > height) {
            height = Math.round(height * MAX / width);
            width = MAX;
          } else {
            width = Math.round(width * MAX / height);
            height = MAX;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        // Strip the data:image/jpeg;base64, prefix
        resolve(dataUrl.split(',')[1]);
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// --- Upload ---
submitBtn.addEventListener('click', async () => {
  if (!currentImage) return;

  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="spinner"></span> Uploading...';

  const selectedTrip = getTripName();
  const payload = {
    image: currentImage,
    account: currentAccount,
    trip_name: selectedTrip,
  };

  try {
    if (navigator.onLine) {
      const resp = await apiCall('POST', '/upload', payload);
      showToast(`Receipt saved! ID: ${resp.id}`, 'success');
    } else {
      // Queue for later
      await queueOfflineUpload(payload);
      showToast('Saved offline — will upload when connected', 'success');
    }

    // Reset form (keep trip selection for batch uploads)
    currentImage = null;
    previewImg.classList.remove('visible');
    previewImg.src = '';
    cameraInput.value = '';
    // If a new trip was created, save it and refresh the dropdown
    if (selectedTrip) {
      localStorage.setItem('lastTrip', selectedTrip);
    }
    if (tripSelect.value === '__new__') {
      tripNameNew.value = '';
      tripNameNew.style.display = 'none';
    }
    await loadTrips();
  } catch (err) {
    showToast(`Upload failed: ${err.message}`, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit Receipt';
  }
});

// --- Offline Queue ---
function openOfflineDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('receipt-tracker-offline', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('upload-queue', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queueOfflineUpload(payload) {
  const db = await openOfflineDB();
  const tx = db.transaction('upload-queue', 'readwrite');
  tx.objectStore('upload-queue').add({
    url: `${API_URL}/upload`,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(payload),
    timestamp: Date.now(),
  });

  // Request background sync if available
  if ('serviceWorker' in navigator && 'sync' in window.SyncManager?.prototype) {
    const reg = await navigator.serviceWorker.ready;
    await reg.sync.register('receipt-upload');
  }
}

// Flush queue when coming back online
window.addEventListener('online', async () => {
  try {
    const db = await openOfflineDB();
    const tx = db.transaction('upload-queue', 'readonly');
    const store = tx.objectStore('upload-queue');
    const req = store.getAll();
    req.onsuccess = async () => {
      const items = req.result;
      if (items.length === 0) return;

      for (const item of items) {
        try {
          const resp = await fetch(item.url, {
            method: 'POST',
            headers: item.headers,
            body: item.body,
          });
          if (resp.ok) {
            const delTx = db.transaction('upload-queue', 'readwrite');
            delTx.objectStore('upload-queue').delete(item.id);
          }
        } catch { /* retry next time */ }
      }
      showToast(`Synced ${items.length} offline receipt(s)`, 'success');
    };
  } catch (err) {
    console.error('Queue flush error:', err);
  }
});

// --- Dashboard ---
async function loadReceipts(reset = false) {
  if (reset) {
    currentOffset = 0;
    receipts = [];
  }

  const params = new URLSearchParams();
  params.set('limit', PAGE_SIZE);
  params.set('offset', currentOffset);

  const account = document.getElementById('filterAccount').value;
  const status = document.getElementById('filterStatus').value;
  const category = document.getElementById('filterCategory').value;
  const trip = document.getElementById('filterTrip').value.trim();

  if (account) params.set('account', account);
  if (status) params.set('status', status);
  if (category) params.set('category', category);
  if (trip) params.set('trip', trip);

  try {
    const data = await apiCall('GET', `/receipts?${params.toString()}`);
    receipts = reset ? data.receipts : receipts.concat(data.receipts);
    renderReceipts();

    loadMoreBtn.style.display = (currentOffset + PAGE_SIZE < data.total) ? 'block' : 'none';
  } catch (err) {
    showToast(`Failed to load receipts: ${err.message}`, 'error');
  }
}

function renderReceipts() {
  if (receipts.length === 0) {
    receiptList.innerHTML = `
      <div class="empty-state">
        <div class="icon">📸</div>
        <p>No receipts found. Tap Capture to get started.</p>
      </div>`;
    return;
  }

  receiptList.innerHTML = receipts.map(r => `
    <div class="receipt-card" data-id="${r.id}">
      <div class="receipt-thumb" style="display:flex;align-items:center;justify-content:center;font-size:1.5rem;">
        ${r.status === 'categorized' ? '✅' : '📋'}
      </div>
      <div class="receipt-info">
        <div class="vendor">${r.vendor || 'Uncategorized Receipt'}</div>
        <div class="meta">
          ${r.receipt_date || r.created_at?.split('T')[0] || '—'} · ${r.account}
          ${r.trip_name ? ` · ${r.trip_name}` : ''}
        </div>
        ${r.amount ? `<div class="amount">${r.currency || ''} ${Number(r.amount).toFixed(2)}</div>` : ''}
        <span class="badge ${r.status}">${r.status}</span>
      </div>
    </div>
  `).join('');

  // Click handlers
  receiptList.querySelectorAll('.receipt-card').forEach(card => {
    card.addEventListener('click', () => showDetail(card.dataset.id));
  });
}

// Filter change handlers
['filterAccount', 'filterStatus', 'filterCategory', 'filterTrip'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => loadReceipts(true));
});

// Populate dashboard trip filter dropdown
async function loadFilterTrips() {
  try {
    const data = await apiCall('GET', '/trips');
    const filterTrip = document.getElementById('filterTrip');
    // Keep "All Trips" option, remove the rest
    while (filterTrip.options.length > 1) filterTrip.remove(1);
    for (const trip of data.trips) {
      const opt = document.createElement('option');
      opt.value = trip.name;
      opt.textContent = `${trip.name} (${trip.receipt_count})`;
      filterTrip.appendChild(opt);
    }
  } catch (err) {
    console.warn('Failed to load filter trips:', err);
  }
}

loadMoreBtn.addEventListener('click', () => {
  currentOffset += PAGE_SIZE;
  loadReceipts(false);
});

// --- Detail View ---
async function showDetail(id) {
  // Switch to detail tab
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelector('[data-screen="detail"]').classList.add('active');
  document.getElementById('screen-detail').classList.add('active');

  try {
    const receipt = await apiCall('GET', `/receipts/${id}`);

    if (receipt.image_url) {
      detailImage.src = receipt.image_url;
      detailImage.style.display = 'block';
    } else {
      detailImage.style.display = 'none';
    }

    const fields = [
      ['ID', receipt.id],
      ['Account', receipt.account],
      ['Status', receipt.status],
      ['Vendor', receipt.vendor],
      ['Amount', receipt.amount ? `${receipt.currency || ''} ${Number(receipt.amount).toFixed(2)}` : null],
      ['Amount (USD)', receipt.amount_usd ? `$${Number(receipt.amount_usd).toFixed(2)}` : null],
      ['Exchange Rate', receipt.exchange_rate],
      ['Date', receipt.receipt_date],
      ['Category', receipt.category],
      ['Tax Category', receipt.tax_category],
      ['Description', receipt.description],
      ['Language', receipt.original_language],
      ['Trip', receipt.trip_name],
      ['OneDrive Path', receipt.onedrive_path],
      ['Created', receipt.created_at],
      ['Updated', receipt.updated_at],
    ];

    detailFields.innerHTML = fields
      .filter(([, val]) => val !== null && val !== undefined)
      .map(([label, val]) => `
        <div class="detail-field">
          <span class="label">${label}</span>
          <span class="value">${val}</span>
        </div>
      `).join('');

    // Line items
    if (receipt.line_items) {
      try {
        const items = typeof receipt.line_items === 'string'
          ? JSON.parse(receipt.line_items)
          : receipt.line_items;
        if (Array.isArray(items) && items.length > 0) {
          detailFields.innerHTML += `
            <div class="detail-field" style="flex-direction:column;gap:4px;">
              <span class="label">Line Items</span>
              ${items.map(item => `<span class="value" style="text-align:left;">${item}</span>`).join('')}
            </div>`;
        }
      } catch { /* skip invalid JSON */ }
    }
  } catch (err) {
    showToast(`Failed to load receipt: ${err.message}`, 'error');
  }
}

detailBack.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelector('[data-screen="dashboard"]').classList.add('active');
  document.getElementById('screen-dashboard').classList.add('active');
  loadReceipts(true);
});

// --- API Helper ---
async function apiCall(method, path, body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const url = path.startsWith('http') ? path : `${API_URL}${path}`;
  const resp = await fetch(url, opts);
  const data = await resp.json();

  if (!resp.ok) {
    throw new Error(data.error || `HTTP ${resp.status}`);
  }
  return data;
}

// --- Toast Notifications ---
function showToast(message, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 4000);
}

// --- Utility ---
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
