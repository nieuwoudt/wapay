const fs = require('fs');
const path = require('path');

const distPath = path.join(__dirname, '../dist');
const nestedSrcPath = path.join(distPath, 'providers/yoyo/src');

if (fs.existsSync(nestedSrcPath)) {
  console.log('Fixing dist structure...');
  
  // Move all files from nested src to root dist
  fs.readdirSync(nestedSrcPath).forEach(file => {
    const srcFile = path.join(nestedSrcPath, file);
    const destFile = path.join(distPath, file);
    
    // Only move if not already exists (to avoid overwriting)
    if (!fs.existsSync(destFile)) {
      fs.renameSync(srcFile, destFile);
    }
  });
  
  // Clean up nested directories
  try {
    fs.rmdirSync(path.join(distPath, 'providers/yoyo/src'), { recursive: true });
    fs.rmdirSync(path.join(distPath, 'providers/yoyo'), { recursive: true });
    fs.rmdirSync(path.join(distPath, 'providers'), { recursive: true });
  } catch (e) {
    // Ignore errors if directories don't exist
  }
  
  console.log('✅ Dist structure fixed!');
} else {
  console.log('✅ Dist structure already correct');
}
