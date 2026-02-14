import { execSync } from 'child_process';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync, appendFileSync, unlinkSync } from 'fs';
import { join, relative, resolve, dirname } from 'path';
import mime from 'mime';
import { createInterface } from 'readline';
import { askConfirmation } from './helpers';

// Configuration - CHANGE THESE TO MATCH YOUR WRANGLER.JSONC
const R2_BUCKET_NAME_PROD = "expo-updates-assets";
const R2_BUCKET_NAME_STAGING = "expo-updates-assets-staging";
const KV_BINDING_NAME = "EXPO_UPDATES_KV";

function printAsciiArt() {
	console.log(`
  ____      _           _   _       _ 
 / ___|___ | | ___  ___| |_(_) __ _| |
| |   / _ \\| |/ _ \\/ __| __| |/ _\` | |
| |__|  __/| |  __/\\__ \\ |_| | (_| | |
 \\____\\___/|_|\\___||___/\\__|_|\\__,_|_|
                                      
 _   _           _       _            
| | | |_ __   __| | __ _| |_ ___  ___ 
| | | | '_ \\ / _\` |/ _\` | __/ _ \\/ __|
| |_| | |_) | (_| | (_| | ||  __/\\__ \\
 \\___/| .__/ \\__,_|\\__,_|\\__\\___||___/
      |_|                             
`);
}

async function askQuestion(question: string): Promise<string> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		rl.question(`${question} `, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

async function selectOption(options: string[], message: string): Promise<string> {
	console.log(message);
	options.forEach((opt, index) => {
		console.log(`${index + 1}. ${opt}`);
	});

	while (true) {
		const answer = await askQuestion(`Select an option (1-${options.length}):`);
		const num = parseInt(answer, 10);
		if (!isNaN(num) && num >= 1 && num <= options.length) {
			return options[num - 1];
		}
		console.log('Invalid selection. Please try again.');
	}
}

export function stripJsonComments(json: string): string {
	return json.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1');
}

export function getJurisdiction(packageRoot: string, bucketName: string, envName?: string): string | undefined {
	const wranglerPath = join(packageRoot, 'wrangler.jsonc');
	if (!existsSync(wranglerPath)) return undefined;

	try {
		const content = readFileSync(wranglerPath, 'utf8');
		const json = stripJsonComments(content);
		const config = JSON.parse(json);
		
		const targetEnv = envName || 'production';
		const buckets = config.env?.[targetEnv]?.r2_buckets || config.r2_buckets || [];
		
		if (Array.isArray(buckets)) {
			const bucket = buckets.find((b: any) => b.bucket_name === bucketName);
			return bucket?.jurisdiction;
		}
		return undefined;
	} catch (e) {
		console.warn('⚠️ Warning: Failed to parse wrangler.jsonc for jurisdiction.');
		return undefined;
	}
}

export async function getAppJsonPath(): Promise<string> {
	// 1. Check EXPO_PROJECT_PATHS env
	const projectPathsRaw = process.env.EXPO_PROJECT_PATHS;
	let projectPaths: string[] = [];
	if (projectPathsRaw) {
		projectPaths = projectPathsRaw.split(',').map(p => p.trim()).filter(p => p);
	}

	let selectedProjectRoot = '';

	if (projectPaths.length === 1) {
		selectedProjectRoot = projectPaths[0];
		console.log(`Using configured project: ${selectedProjectRoot}`);
	} else if (projectPaths.length > 1) {
		selectedProjectRoot = await selectOption(projectPaths, 'Multiple Expo projects found. Please select one:');
	} else {
		// 2. Prompt user
		console.log('No Expo project configured.');
		while (!selectedProjectRoot) {
			const inputPath = await askQuestion('Enter the absolute path to your Expo project root (folder containing app.json):');
			if (inputPath) {
				const resolvedPath = resolve(inputPath);
				if (existsSync(join(resolvedPath, 'app.json'))) {
					selectedProjectRoot = resolvedPath;
				} else {
					console.error(`❌ app.json not found in ${resolvedPath}`);
				}
			}
		}

		// Ask to save
		const save = await askConfirmation('Do you want to save this path to .env for future use?');
		if (save) {
			const envPath = join(__dirname, '..', '.env');
			const envContent = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
			
			// Check if EXPO_PROJECT_PATHS exists
			if (envContent.includes('EXPO_PROJECT_PATHS=')) {
				// This is a bit simplistic (doesn't handle multi-line etc well if complex), 
				// but for a simple env file it works. Better to append or warn.
				console.log(`⚠️  EXPO_PROJECT_PATHS already exists in .env. Please update it manually to include: ${selectedProjectRoot}`);
			} else {
				appendFileSync(envPath, `\nEXPO_PROJECT_PATHS=${selectedProjectRoot}\n`);
				console.log(`✅ Saved to .env`);
			}
		}
	}

	return join(selectedProjectRoot, 'app.json');
}

export async function publish() {
	printAsciiArt();

	// 0. Setup Paths
	const packageRoot = join(__dirname, '..');
	
	const appJsonPath = await getAppJsonPath();
	if (!existsSync(appJsonPath)) {
		console.error(`❌ Error: app.json not found at ${appJsonPath}`);
		process.exit(1);
	}
	const projectRoot = dirname(appJsonPath);

	const wranglerPersistPath = join(packageRoot, '.wrangler', 'state');

	// Check for --remote flag
	const isRemote = process.argv.includes('--remote');

	// Check for --env flag
	const envArgIndex = process.argv.indexOf('--env');
	const envName = envArgIndex !== -1 ? process.argv[envArgIndex + 1] : undefined;

	const R2_BUCKET_NAME = envName === 'staging' ? R2_BUCKET_NAME_STAGING : R2_BUCKET_NAME_PROD;
	const jurisdiction = getJurisdiction(packageRoot, R2_BUCKET_NAME, envName);

	if (isRemote) {
		const confirmed = await askConfirmation('⚠️ You are about to publish to REMOTE (R2 and KV). Are you sure?');
		if (!confirmed) {
			console.log('Publish aborted.');
			return;
		}
	}

	let wranglerArgs = isRemote ? '--remote' : `--persist-to="${wranglerPersistPath}"`;
	if (envName) {
		wranglerArgs += ` --env ${envName}`;
	} else {
		wranglerArgs += ` --env production`;
	}

	console.log(`Publishing mode: ${isRemote ? 'REMOTE' : 'LOCAL'}`);
	if (envName) {
		console.log(`Environment: ${envName}`);
	} else {
		console.log(`Environment: production`);
	}
	console.log(`Target Bucket: ${R2_BUCKET_NAME}`);
	if (jurisdiction) {
		console.log(`Jurisdiction: ${jurisdiction}`);
	}
	console.log(`Expo Project Root: ${projectRoot}`);
	console.log(`Package Root: ${packageRoot}`);

	// 1. Get runtimeVersion from app.json
	let appJson;
	try {
		appJson = JSON.parse(readFileSync(appJsonPath, 'utf8'));
	} catch (e) {
		console.error(`❌ Could not parse app.json at ${appJsonPath}.`);
		process.exit(1);
	}

	const projectSlug = appJson.expo?.slug || appJson.slug || appJson.name || 'default';

	// CHECK FOR CODE SIGNING KEYS
	const updatesConfig = appJson.expo?.updates || appJson.updates;
	if (updatesConfig?.codeSigningCertificate) {
		const certPath = resolve(projectRoot, updatesConfig.codeSigningCertificate);
		if (!existsSync(certPath)) {
			console.error(`❌ Code signing certificate not found at: ${certPath}`);
			console.log(`
To fix this, you need to generate code signing keys.
Your app.json expects them at: ${updatesConfig.codeSigningCertificate}

Example app.json configuration:
"updates": {
    "url": "https://your-worker.workers.dev/api/manifest",
    "enabled": true,
    "codeSigningCertificate": "./code-signing/certificate.pem",
    "codeSigningMetadata": {
        "keyid": "main",
        "alg": "rsa-v1_5-sha256"
    }
}
`);
			const shouldGenerate = await askConfirmation('Do you want to generate code signing keys now?');
			if (shouldGenerate) {
				const defaultKeyPath = 'code-signing/private-key.pem';
				const defaultCertPath = 'code-signing/certificate.pem';
				
				// Ensure directory exists
				const certDir = dirname(certPath);
				if (!existsSync(certDir)) {
					mkdirSync(certDir, { recursive: true });
				}

				try {
					console.log('Generating keys...');
					// Use output directory from the configured path
					const outputDir = certDir; 
					// Default validity and common name
					const validityDuration = 10;
					const commonName = appJson.name || 'Expo App';

					execSync(
						`bunx expo-updates codesigning:generate --key-output-directory "${outputDir}" --certificate-output-directory "${outputDir}" --certificate-validity-duration-years ${validityDuration} --certificate-common-name "${commonName}"`, 
						{
							cwd: projectRoot,
							stdio: 'inherit'
						}
					);
					console.log('✅ Keys generated successfully.');
					
					// We need to verify if the generated files match what is in app.json. 
					// The command generates 'certificate.pem', 'public-key.pem', 'private-key.pem'.
					const generatedCertPath = join(outputDir, 'certificate.pem');

					if (resolve(generatedCertPath) !== resolve(certPath)) {
						console.warn(`⚠️  Keys generated at ${generatedCertPath}, but app.json points to ${updatesConfig.codeSigningCertificate}. Please update app.json or rename the file.`);
                        process.exit(1);
					}

                    // Add to .gitignore
                    const gitignorePath = join(projectRoot, '.gitignore');
                    if (existsSync(gitignorePath)) {
                        let gitignoreContent = readFileSync(gitignorePath, 'utf8');
                        const relativeCertDir = relative(projectRoot, outputDir);
                        if (!gitignoreContent.includes(relativeCertDir)) {
                            appendFileSync(gitignorePath, `\n# Expo Code Signing Keys\n${relativeCertDir}/\n`);
                            console.log(`🔒 Added ${relativeCertDir} to .gitignore.`);
                        }
                    }

                    console.log('\n⚠️  IMPORTANT: The code signing keys directory has been added to .gitignore.');
                    console.log('   You MUST store these keys securely (e.g., in a password manager or secure vault).');
                    console.log('   If you lose the private key, you will NOT be able to sign future updates for this app!\n');

					const confirmed = await askConfirmation('I confirm that I have backed up my keys and understand they are ignored by git. Continue?');
					if (!confirmed) {
						console.log('Aborting. Please backup your keys.');
						process.exit(1);
					}

				} catch (e) {
					console.error('❌ Failed to generate keys.');
					process.exit(1);
				}
			} else {
				console.log('Aborting publish. Please fix code signing configuration.');
				process.exit(1);
			}
		}
	}

	// Secret Upload Logic
	if (updatesConfig?.codeSigningCertificate) {
		const certPath = resolve(projectRoot, updatesConfig.codeSigningCertificate);
		const keyPath = join(dirname(certPath), 'private-key.pem'); 
		if (existsSync(keyPath)) {
			const secretName = `EXPO_UPDATES_PRIVATE_KEY_${projectSlug.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
			const envFlag = envName ? `--env ${envName}` : '--env production';

			try {
				console.log('Checking if secret exists in Cloudflare...');
				// We use 'pipe' to capture output, but we might want to suppress stderr if it's noisy
				const secretListOutput = execSync(`bunx wrangler secret list --format json ${envFlag}`, {
					cwd: packageRoot,
					encoding: 'utf-8',
                    stdio: ['ignore', 'pipe', 'ignore'] // ignore stdin/stderr, capture stdout
				});
				
				let secretExists = false;
				try {
					const secrets = JSON.parse(secretListOutput);
					if (Array.isArray(secrets)) {
						secretExists = secrets.some((s: any) => s.name === secretName);
					}
				} catch (e) {
					// Fallback if parsing fails, maybe just assume it doesn't exist or warn
					console.warn('⚠️  Failed to parse secret list. You may need to manually verify secrets.');
				}

				if (!secretExists) {
					const upload = await askConfirmation(`Do you want to upload the private key to Cloudflare Secret '${secretName}'?`);
					if (upload) {
						try {
							execSync(`bunx wrangler secret put ${secretName} < "${keyPath}" ${envFlag}`, {
								cwd: packageRoot,
								stdio: 'inherit'
							});
							console.log(`✅ Secret ${secretName} uploaded.`);
						} catch (e) {
							console.error(`❌ Failed to upload secret.`);
						}
					}
				} else {
					console.log(`ℹ️  Secret '${secretName}' already exists. Skipping upload.`);
				}
			} catch (e) {
				console.warn('⚠️  Could not check secrets (wrangler secret list failed). You can verify manually.');
			}
		}
	}
	
	// Support both expo.runtimeVersion and runtimeVersion (bare workflow might vary, but standard is expo.runtimeVersion)
	let runtimeVersion = appJson.expo?.runtimeVersion || appJson.runtimeVersion;

	if (typeof runtimeVersion === 'object' && runtimeVersion !== null) {
		if (runtimeVersion.policy === 'appVersion') {
			runtimeVersion = appJson.expo?.version || appJson.version;
		} else if (runtimeVersion.policy === 'sdkVersion') {
			runtimeVersion = appJson.expo?.sdkVersion || appJson.sdkVersion;
		} else {
			console.error(`❌ Unsupported runtimeVersion policy: ${JSON.stringify(runtimeVersion)}. Please use a string or "policy": "appVersion" / "sdkVersion".`);
			process.exit(1);
		}
	}

	if (!runtimeVersion) {
		console.error('❌ No runtimeVersion found in app.json under "expo.runtimeVersion" (or resolved from policy).');
		process.exit(1);
	}

	// Ensure it is a string
	runtimeVersion = String(runtimeVersion);

	// 2. Get timestamp and create local path
	const timestamp = Date.now().toString();
	// We create the 'updates' folder inside the Expo Project Root to keep it with the app usually, 
	// or we can create it in the worker package. 
	// Let's create it in the worker package to keep the Expo project clean, 
	// OR in the Expo project to mimic `expo export`. 
	// Standard `expo export` output is inside the project. Let's keep it there.
	const localUpdatePath = join(projectRoot, 'dist-updates', runtimeVersion, timestamp); 
	// Note: changed to dist-updates to avoid conflict with standard 'updates' folder if any
	
	const r2Path = `${projectSlug}/updates/${runtimeVersion}/${timestamp}`;

	console.log(`Publishing update for runtimeVersion: ${runtimeVersion} at ${timestamp}`);
	mkdirSync(localUpdatePath, { recursive: true });

	// 3. Run expo export with output-dir
	console.log(`Running expo export to ${localUpdatePath}...`);
	try {
        // We run this in the Expo Project Root
		execSync(`bunx expo prebuild`, { cwd: projectRoot, stdio: 'inherit' });
		execSync(`bunx expo export --output-dir "${localUpdatePath}"`, { cwd: projectRoot, stdio: 'inherit' });
	} catch (e) {
		console.error("❌ Failed to run expo export. Please check the logs above.");
		process.exit(1);
	}

	// 4. Export client expo config
	console.log('Exporting client expo config...');
	try {
		// We use the projectRoot to resolve the config
		const { exp } = require('@expo/config').getConfig(projectRoot, {
			skipSDKVersionRequirement: true,
			isPublicConfig: true,
		});
		const expoConfig = JSON.stringify(exp);
		const expoConfigPath = join(localUpdatePath, 'expoConfig.json');
		writeFileSync(expoConfigPath, expoConfig);
	} catch (e) {
		console.error("❌ Failed to export expo config. Make sure @expo/config is installed in your Expo project.");
		process.exit(1);
	}

	// Read metadata.json to map assets to extensions
	const metadataPath = join(localUpdatePath, 'metadata.json');
	if (!existsSync(metadataPath)) {
		console.error(`❌ metadata.json not found at ${metadataPath}. Expo export might have failed.`);
		process.exit(1);
	}
	const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
	const assetContentTypeMap = new Map<string, string>();

	// Helper to populate map
	const processMetadataPlatform = (platformData: any) => {
		if (platformData?.assets) {
			platformData.assets.forEach((asset: any) => {
				if (asset.path && asset.ext) {
					const type = mime.getType(asset.ext);
					if (type) {
						assetContentTypeMap.set(asset.path, type);
					}
				}
			});
		}
		if (platformData?.bundle) {
			assetContentTypeMap.set(platformData.bundle, 'application/javascript');
		}
	};

	processMetadataPlatform(metadata.fileMetadata?.ios);
	processMetadataPlatform(metadata.fileMetadata?.android);

	// 5. Upload files to R2
	console.log('Uploading files to R2 using bulk upload...');
	const files = getAllFiles(localUpdatePath);
	const filesByContentType = new Map<string, Array<{ key: string; file: string }>>();

	for (const file of files) {
		const relativePath = relative(localUpdatePath, file);
		const key = `${r2Path}/${relativePath}`;

		let contentType = assetContentTypeMap.get(relativePath);
		if (!contentType) {
			contentType = mime.getType(file) || 'application/octet-stream';
		}

		if (!filesByContentType.has(contentType)) {
			filesByContentType.set(contentType, []);
		}
		filesByContentType.get(contentType)?.push({ key, file });
	}

	for (const [contentType, fileList] of filesByContentType) {
		console.log(`Uploading ${fileList.length} files with content-type: ${contentType}...`);
		const tempJsonPath = join(localUpdatePath, `upload_list_${Date.now()}_${Math.floor(Math.random() * 1000)}.json`);
		writeFileSync(tempJsonPath, JSON.stringify(fileList));

		const jurisdictionFlag = jurisdiction ? ` --jurisdiction "${jurisdiction}"` : '';

		try {
			execSync(
				`bunx wrangler r2 bulk put "${R2_BUCKET_NAME}" --filename="${tempJsonPath}" --content-type="${contentType}" --concurrency 50 ${wranglerArgs}${jurisdictionFlag}`,
				{
					cwd: packageRoot,
					stdio: 'inherit',
				}
			);
		} finally {
			// Clean up the temporary file
			if (existsSync(tempJsonPath)) {
				unlinkSync(tempJsonPath);
			}
		}
	}

	// 6. Update KV
	console.log('Updating KV...');
	const latestKey = `${projectSlug}:update:${runtimeVersion}:latest`;
	const historyKey = `${projectSlug}:update:${runtimeVersion}:history`;

	// Update latest
	execSync(`bunx wrangler kv key put --binding=${KV_BINDING_NAME} "${latestKey}" "${timestamp}" ${wranglerArgs}`, {
		cwd: packageRoot,
		stdio: 'inherit',
	});

	// Update history
	let history: string[] = [];
	try {
		const historyJson = execSync(`bunx wrangler kv key get --binding=${KV_BINDING_NAME} "${historyKey}" ${wranglerArgs}`, {
			cwd: packageRoot,
			stdio: ['ignore', 'pipe', 'ignore'],
		}).toString();
		history = JSON.parse(historyJson);
	} catch (e) {
		console.log('No existing history found or error reading it, starting fresh.');
	}

	history.unshift(timestamp);

	execSync(`bunx wrangler kv key put --binding=${KV_BINDING_NAME} "${historyKey}" '${JSON.stringify(history)}' ${wranglerArgs}`, {
		cwd: packageRoot,
		stdio: 'inherit',
	});

	// Optional: Create a version control file in the Expo project
	try {
		const updatesVersionsDir = join(projectRoot, 'updates-versions');
		if (existsSync(projectRoot) && !existsSync(updatesVersionsDir)) {
			mkdirSync(updatesVersionsDir, { recursive: true });
		}
		
		if (existsSync(updatesVersionsDir)) {
			const versionFilePath = join(updatesVersionsDir, timestamp);
			let commitHistory = '';
			try {
				const lastReleaseHash = execSync('git log --grep="release" -n 1 --format="%H"', { cwd: projectRoot, encoding: 'utf-8' }).trim();
				if (lastReleaseHash) {
					commitHistory = execSync(`git log ${lastReleaseHash}..HEAD --pretty=format:"%H - %s (%cr)"`, { cwd: projectRoot, encoding: 'utf-8' });
				} else {
					commitHistory = execSync('git log -n 10 --pretty=format:"%H - %s (%cr)"', { cwd: projectRoot, encoding: 'utf-8' });
				}
			} catch (e) {
				commitHistory = 'Error fetching git history or not a git repo.';
			}
			writeFileSync(versionFilePath, commitHistory);
			console.log(`Created version file: ${versionFilePath}`);
		}
	} catch (err) {
		console.warn("Skipping version file creation due to error:", err);
	}

	console.log('✅ Publish complete!');
	console.log('\n🔐  Ensure the following secret exists in your Cloudflare Worker:');
	const expectedSecretName = `EXPO_UPDATES_PRIVATE_KEY_${projectSlug.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
	console.log(`    - ${expectedSecretName}`);
	console.log('    (This is required for code signing to work correctly with multi-project support)\n');

	console.log('📋 Double check your app.json configuration:');
	console.log(`   "updates": {`);
	console.log(`       "url": "https://<your-worker-url>/${projectSlug}/api/manifest",`);
	console.log(`       ...`);
	console.log(`   }\n`);
}

function getAllFiles(dir: string, fileList: string[] = []): string[] {
	const files = readdirSync(dir);
	files.forEach((file) => {
		const filePath = join(dir, file);
		if (statSync(filePath).isDirectory()) {
			getAllFiles(filePath, fileList);
		} else {
			fileList.push(filePath);
		}
	});
	return fileList;
}

if (import.meta.main) {
    publish().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}