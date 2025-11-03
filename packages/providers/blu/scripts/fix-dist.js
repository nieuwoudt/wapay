#!/usr/bin/env node
/**
 * Fix the dist folder structure after TypeScript compilation
 * 
 * TypeScript outputs to dist/providers/blu/src/* because it includes dependencies
 * We need to move files to dist/* for proper imports
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { cpSync, rmSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, '..');
const distDir = join(packageRoot, 'dist');
const srcOutput = join(distDir, 'providers', 'blu', 'src');

// Check if the nested structure exists
if (existsSync(srcOutput)) {
  console.log('Fixing dist structure...');
  
  // Copy files from nested location to dist root
  cpSync(srcOutput, distDir, { recursive: true });
  
  // Remove the nested directories
  rmSync(join(distDir, 'providers'), { recursive: true, force: true });
  rmSync(join(distDir, 'utils'), { recursive: true, force: true });
  
  console.log('✅ Dist structure fixed!');
} else {
  console.log('✅ Dist structure already correct');
}

