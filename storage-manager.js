/**
 * CashHub PH Storage Manager
 * Handles localStorage quota issues, image compression, and data recovery
 * 
 * Solves: transactions disappearing due to QuotaExceededError
 */

// ════════════════════════════════════════════════════════════════
// IMAGE COMPRESSION
// ════════════════════════════════════════════════════════════════

/**
 * Compress image to reduce storage size
 * @param {string} dataUrl - Base64 image data URL
 * @param {number} maxWidth - Max width in pixels (default 800)
 * @param {number} quality - JPEG quality 0-1 (default 0.6)
 * @returns {Promise<string>} - Compressed image data URL
 */
async function compressImage(dataUrl, maxWidth = 800, quality = 0.6) {
  return new Promise((resolve) => {
    if (!dataUrl || dataUrl.length < 1000) {
      resolve(dataUrl); // Too small, don't compress
      return;
    }

    const img = new Image();
    img.onload = function() {
      try {
        const canvas = document.createElement('canvas');
        let w = img.naturalWidth;
        let h = img.naturalHeight;

        // Scale down if larger than maxWidth
        if (w > maxWidth) {
          h = Math.round((h * maxWidth) / w);
          w = maxWidth;
        }

        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);

        // Convert to JPEG with compression
        const compressed = canvas.toDataURL('image/jpeg', quality);
        const originalSize = dataUrl.length;
        const compressedSize = compressed.length;
        const savings = Math.round(((originalSize - compressedSize) / originalSize) * 100);

        console.log(
          `[Storage] Image compressed: ${originalSize} → ${compressedSize} bytes (${savings}% reduction)`
        );

        // Only use compressed if it's actually smaller
        resolve(compressedSize < originalSize ? compressed : dataUrl);
      } catch (e) {
        console.warn('[Storage] Compression error:', e);
        resolve(dataUrl); // fallback to original
      }
    };

    img.onerror = () => {
      console.warn('[Storage] Image load failed for compression');
      resolve(dataUrl); // fallback to original
    };

    img.src = dataUrl;
  });
}

// ════════════════════════════════════════════════════════════════
// STORAGE QUOTA MONITORING
// ════════════════════════════════════════════════════════════════

/**
 * Check localStorage quota usage
 * @returns {Promise<{available: boolean, percent: number, usage: number, quota: number}>}
 */
async function checkStorageQuota() {
  // Fallback for browsers without storage API
  if (!navigator.storage || !navigator.storage.estimate) {
    console.warn('[Storage] Quota API not available');
    return {
      available: true,
      percent: 50,
      usage: 0,
      quota: 10 * 1024 * 1024 // assume 10MB
    };
  }

  try {
    const estimate = await navigator.storage.estimate();
    const percentUsed = (estimate.usage / estimate.quota) * 100;

    return {
      available: percentUsed < 90,
      percent: percentUsed,
      usage: estimate.usage,
      quota: estimate.quota
    };
  } catch (e) {
    console.warn('[Storage] Quota check error:', e);
    return {
      available: true,
      percent: 50,
      usage: 0,
      quota: 10 * 1024 * 1024
    };
  }
}

/**
 * Format bytes to human readable size
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

// ════════════════════════════════════════════════════════════════
// IMPROVED SAVE WITH QUOTA CHECKING
// ════════════════════════════════════════════════════════════════

/**
 * Enhanced saveDB with quota checking and error handling
 * REPLACE the original saveDB() function with this
 * 
 * @returns {Promise<boolean>} - true if save successful, false if failed
 */
async function saveDBWithQuotaCheck() {
  try {
    // Check quota first
    const quota = await checkStorageQuota();

    console.log(
      `[Storage] Usage: ${formatBytes(quota.usage)} / ${formatBytes(quota.quota)} (${quota.percent.toFixed(1)}%)`
    );

    // CRITICAL: Warn if quota is nearly full
    if (quota.percent > 95) {
      showToast('❌ Storage nearly full! Cannot save. Delete old transactions first.');
      return false;
    }

    if (quota.percent > 85) {
      showToast(
        `⚠️ Storage ${quota.percent.toFixed(0)}% full. You have ~${formatBytes(quota.quota - quota.usage)} left.`
      );
    }

    // Attempt to serialize and save
    const serialized = JSON.stringify(DB);
    const dataSize = new Blob([serialized]).size;

    console.log(`[Storage] Attempting to save ${formatBytes(dataSize)} of data`);

    // Check if this save would exceed quota
    if (quota.usage + dataSize > quota.quota * 0.95) {
      console.error('[Storage] Save would exceed quota', {
        current: quota.usage,
        new: dataSize,
        total: quota.quota
      });
      showToast(
        '❌ Not enough storage! Clear old transactions or export to CSV before continuing.'
      );
      return false;
    }

    // Attempt save
    localStorage.setItem('cashhub_ph_v3', serialized);

    console.log('[Storage] Save successful');

    // Post-save warnings
    if (quota.percent > 80) {
      console.warn(
        `[Storage] Quota is ${quota.percent.toFixed(0)}% full. Consider exporting old data.`
      );
    }

    return true;
  } catch (e) {
    // Handle specific errors
    if (e.name === 'QuotaExceededError') {
      console.error('[Storage] QuotaExceededError! Data was NOT saved', {
        error: e.message,
        timestamp: new Date().toISOString()
      });
      showToast('❌ Storage full! Cannot save transaction. Delete old records to free space.');
      return false;
    }

    if (e.name === 'SecurityError' || e.name === 'TypeError') {
      // iOS private mode or other security issue
      console.error('[Storage] Security error (may be private mode):', e);
      showToast('⚠️ Cannot save in private mode. Switch to normal browsing mode.');
      return false;
    }

    console.error('[Storage] Unexpected save error:', e);
    showToast('❌ Storage error: ' + e.message);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════
// STORAGE HEALTH CHECK
// ════════════════════════════════════════════════════════════════

/**
 * Diagnose storage health and data integrity
 * @returns {{healthy: boolean, issues: string[], stats: object}}
 */
function diagnoseStorageHealth() {
  const issues = [];
  const stats = {
    dataFound: false,
    txCount: 0,
    dataSize: '0 Bytes',
    hasImages: 0,
    hasSignatures: 0,
    corrupted: false
  };

  try {
    const stored = localStorage.getItem('cashhub_ph_v3');

    if (!stored) {
      issues.push('No stored data found in localStorage');
      return { healthy: false, issues, stats };
    }

    stats.dataFound = true;
    stats.dataSize = formatBytes(new Blob([stored]).size);

    const parsed = JSON.parse(stored);

    // Check structure
    if (!parsed.transactions || !Array.isArray(parsed.transactions)) {
      issues.push('Transaction array missing or invalid');
      stats.corrupted = true;
    } else {
      stats.txCount = parsed.transactions.length;

      // Count image data
      parsed.transactions.forEach((t) => {
        if (t.imageData) stats.hasImages++;
        if (t.signature) stats.hasSignatures++;
      });
    }

    // Check other fields
    if (!parsed.settings) issues.push('Settings missing');
    if (!parsed.deposits) issues.push('Deposits missing');

    const healthy = issues.length === 0;
    return { healthy, issues, stats };
  } catch (e) {
    issues.push(`Parse error: ${e.message}`);
    return { healthy: false, issues, stats: { ...stats, corrupted: true } };
  }
}

/**
 * Show storage diagnostics UI
 */
async function showStorageDiagnostics() {
  const health = diagnoseStorageHealth();
  const quota = await checkStorageQuota();

  let msg = '📊 **Storage Diagnostics**\n\n';

  // Health status
  msg += health.healthy ? '✅ Data is healthy\n' : '⚠️ Issues detected:\n';
  health.issues.forEach((issue) => {
    msg += `  • ${issue}\n`;
  });

  msg += '\n**Data Stats:**\n';
  msg += `  Transactions: ${health.stats.txCount}\n`;
  msg += `  Total size: ${health.stats.dataSize}\n`;
  msg += `  With images: ${health.stats.hasImages}\n`;
  msg += `  With signatures: ${health.stats.hasSignatures}\n`;

  msg += '\n**Storage Quota:**\n';
  msg += `  Used: ${formatBytes(quota.usage)}\n`;
  msg += `  Total: ${formatBytes(quota.quota)}\n`;
  msg += `  Usage: ${quota.percent.toFixed(1)}%\n`;

  if (quota.percent > 80) {
    msg += `  ⚠️ Near capacity! Only ${formatBytes(quota.quota - quota.usage)} remaining\n`;
  }

  // Show as alert (or better: create a modal)
  alert(msg);

  // Also log detailed info
  console.log('[Storage Diagnostics]', { health, quota });
}

// ════════════════════════════════════════════════════════════════
// CLEAN UP OLD TRANSACTIONS
// ════════════════════════════════════════════════════════════════

/**
 * Remove transactions older than X days to free storage
 * @param {number} daysOld - Delete transactions older than this many days
 * @returns {number} - Number of transactions deleted
 */
function deleteOldTransactions(daysOld = 90) {
  const before = DB.transactions.length;
  const cutoffDate = Date.now() - daysOld * 24 * 60 * 60 * 1000;

  DB.transactions = DB.transactions.filter((t) => {
    const txDate = new Date(t.date).getTime();
    return txDate > cutoffDate;
  });

  const deleted = before - DB.transactions.length;
  if (deleted > 0) {
    saveDB();
    const freed = formatBytes(deleted * 50000); // rough estimate: 50KB per tx with images
    showToast(`🗑️ Deleted ${deleted} old transactions, freed ~${freed}`);
    console.log(`[Storage] Deleted ${deleted} transactions older than ${daysOld} days`);
  }

  return deleted;
}

/**
 * Strip image data from old transactions to free space
 * @param {number} daysOld - Strip images from transactions older than this
 * @returns {number} - Number of images removed
 */
function stripOldImages(daysOld = 30) {
  const cutoffDate = Date.now() - daysOld * 24 * 60 * 60 * 1000;
  let stripped = 0;

  DB.transactions.forEach((t) => {
    const txDate = new Date(t.date).getTime();
    if (txDate < cutoffDate && (t.imageData || t.signature)) {
      if (t.imageData) {
        console.log('[Storage] Stripped receipt image from', t.txId);
        t.imageData = null;
      }
      if (t.signature) {
        console.log('[Storage] Stripped signature from', t.txId);
        t.signature = null;
      }
      stripped++;
    }
  });

  if (stripped > 0) {
    saveDB();
    const freed = formatBytes(stripped * 200000); // rough estimate
    showToast(`📸 Removed images from ${stripped} old transactions, freed ~${freed}`);
  }

  return stripped;
}

// ════════════════════════════════════════════════════════════════
// DATA EXPORT & RECOVERY
// ════════════════════════════════════════════════════════════════

/**
 * Export transaction metadata (without large images)
 * This is a safe backup that won't exceed email/cloud limits
 */
function exportTransactionMetadata() {
  const backup = {
    version: 3,
    timestamp: new Date().toISOString(),
    transactions: DB.transactions.map((t) => ({
      id: t.id,
      txId: t.txId,
      type: t.type,
      date: t.date,
      name: t.name,
      phone: t.phone,
      amount: t.amount,
      fee: t.fee,
      ref: t.ref,
      status: t.status,
      hasImage: !!t.imageData,
      hasSignature: !!t.signature,
      note: t.note
    })),
    settings: DB.settings,
    deposits: DB.deposits,
    stats: {
      totalTransactions: DB.transactions.length,
      totalSales: DB.transactions.reduce((a, t) => a + (parseFloat(t.amount) || 0), 0),
      totalFees: DB.transactions.reduce((a, t) => a + (parseFloat(t.fee) || 0), 0)
    }
  };

  const json = JSON.stringify(backup, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cashhub_backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);

  showToast('✓ Backup exported (metadata only, no images)');
  console.log('[Storage] Exported backup:', backup);
}

/**
 * Import backup data
 * @param {File} file - JSON backup file
 */
async function importBackupFile(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const backup = JSON.parse(e.target.result);

        if (backup.version !== 3) {
          showToast('⚠️ Backup version mismatch');
          resolve(false);
          return;
        }

        // Merge transactions (don't overwrite, add new ones)
        const existingIds = new Set(DB.transactions.map((t) => t.txId));
        let imported = 0;

        backup.transactions.forEach((t) => {
          if (!existingIds.has(t.txId)) {
            DB.transactions.push(t);
            imported++;
          }
        });

        // Merge settings
        if (backup.settings) {
          DB.settings = { ...DB.settings, ...backup.settings };
        }

        await saveDBWithQuotaCheck();
        showToast(`✓ Imported ${imported} new transactions from backup`);
        resolve(true);
      } catch (err) {
        showToast('❌ Import failed: ' + err.message);
        console.error('[Storage] Import error:', err);
        resolve(false);
      }
    };
    reader.onerror = () => {
      showToast('❌ Failed to read backup file');
      resolve(false);
    };
    reader.readAsText(file);
  });
}

// ════════════════════════════════════════════════════════════════
// ENHANCED TRANSACTION SAVE
// ════════════════════════════════════════════════════════════════

/**
 * Save transaction with image compression and quota checking
 * REPLACES the original saveTransaction() function
 * 
 * @param {object} tx - Transaction object to save
 * @returns {Promise<boolean>} - true if saved successfully
 */
async function saveTransactionWithCompression(tx) {
  try {
    console.log('[Storage] Saving transaction:', tx.txId);

    // Compress images before saving
    if (tx.imageData) {
      console.log('[Storage] Compressing receipt image...');
      tx.imageData = await compressImage(tx.imageData, 600, 0.5);
    }

    if (tx.signature) {
      console.log('[Storage] Compressing signature...');
      tx.signature = await compressImage(tx.signature, 400, 0.6);
    }

    // Add to DB
    tx.status = 'completed';
    if (!DB.transactions.find((t) => t.id === tx.id)) {
      DB.transactions.unshift(tx);
      console.log('[Storage] Transaction added to DB');
    }

    // Save with quota check
    const saved = await saveDBWithQuotaCheck();

    if (saved) {
      showToast('✓ Transaction saved');
      return true;
    } else {
      // Remove from DB if save failed
      DB.transactions = DB.transactions.filter((t) => t.id !== tx.id);
      showToast('❌ Transaction NOT saved due to storage error');
      return false;
    }
  } catch (e) {
    console.error('[Storage] Transaction save error:', e);
    showToast('❌ Error saving transaction: ' + e.message);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════
// EXPORT FOR INTEGRATION
// ════════════════════════════════════════════════════════════════

// Make functions globally available
window.StorageManager = {
  compressImage,
  checkStorageQuota,
  formatBytes,
  saveDBWithQuotaCheck,
  diagnoseStorageHealth,
  showStorageDiagnostics,
  deleteOldTransactions,
  stripOldImages,
  exportTransactionMetadata,
  importBackupFile,
  saveTransactionWithCompression
};
