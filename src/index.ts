import { Hono } from 'hono';
import { serializeDictionary } from 'structured-headers';
import mime from 'mime';

type Bindings = {
	EXPO_UPDATES_BUCKET: R2Bucket;
	EXPO_UPDATES_KV: KVNamespace;
	EXPO_UPDATES_PRIVATE_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Helpers
function convertSHA256HashToUUID(value: string) {
	return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

function getBase64URLEncoding(base64: string): string {
	return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function createHash(data: ArrayBuffer, algorithm: 'SHA-256' | 'MD5', encoding: 'hex' | 'base64' = 'hex'): Promise<string> {
	const hashBuffer = await crypto.subtle.digest(algorithm, data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	
	if (encoding === 'hex') {
		return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
	}
	
	const binary = String.fromCharCode(...hashArray);
	return btoa(binary);
}

async function signRSASHA256(data: string, privateKeyPem: string): Promise<string> {
	const pemContents = privateKeyPem
		.replace(/-----BEGIN RSA PRIVATE KEY-----/, '')
		.replace(/-----END RSA PRIVATE KEY-----/, '')
		.replace(/\s+/g, ''); // Remove all whitespace, newlines, etc.

	const binaryDerString = atob(pemContents);
	const binaryDer = new Uint8Array(binaryDerString.length);
	for (let i = 0; i < binaryDerString.length; i++) {
		binaryDer[i] = binaryDerString.charCodeAt(i);
	}

	const key = await crypto.subtle.importKey(
		'pkcs8',
		binaryDer,
		{
			name: 'RSASSA-PKCS1-v1_5',
			hash: 'SHA-256',
		},
		false,
		['sign']
	);

	const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data));
	const binarySignature = String.fromCharCode(...new Uint8Array(signature));
	return btoa(binarySignature);
}

function convertToDictionaryItemsRepresentation(obj: { [key: string]: string }) {
	return new Map(
		Object.entries(obj).map(([k, v]) => {
			return [k, [v, new Map()]] as [string, [string, Map<string, any>]];
		})
	);
}

// Routes
app.get('/:projectSlug/api/manifest', async (c) => {
	const { projectSlug } = c.req.param();
	const protocolVersion = parseInt(c.req.header('expo-protocol-version') ?? '0', 10);
	const platform = c.req.header('expo-platform') ?? c.req.query('platform');
	const runtimeVersion = c.req.header('expo-runtime-version') ?? c.req.query('runtime-version');
	const currentUpdateId = c.req.header('expo-current-update-id');

	if (platform !== 'ios' && platform !== 'android') {
		return c.json({ error: 'Unsupported platform. Expected either ios or android.' }, 400);
	}

	if (!runtimeVersion) {
		return c.json({ error: 'No runtimeVersion provided.' }, 400);
	}

	// Dynamic Secret Lookup
	const secretName = `EXPO_UPDATES_PRIVATE_KEY_${projectSlug.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
	const privateKey = (c.env as any)[secretName] as string | undefined;

	if (!privateKey) {
		return c.json({ error: 'Code signing key not configured for this project.' }, 500);
	}

	const latestTimestamp = await c.env.EXPO_UPDATES_KV.get(`${projectSlug}:update:${runtimeVersion}:latest`);

	if (!latestTimestamp) {
		return c.json({ error: 'No update found for this runtime version.' }, 404);
	}

	const updatePath = `${projectSlug}/updates/${runtimeVersion}/${latestTimestamp}`;

	// Check for rollback
	const rollbackRes = await c.env.EXPO_UPDATES_BUCKET.head(`${updatePath}/rollback`);
	if (rollbackRes) {
		if (protocolVersion === 0) {
			return c.json({ error: 'Rollbacks not supported on protocol version 0' }, 400);
		}

		const embeddedUpdateId = c.req.header('expo-embedded-update-id');
		if (!embeddedUpdateId) {
			return c.json({ error: 'Invalid Expo-Embedded-Update-ID request header specified.' }, 400);
		}

		if (currentUpdateId === embeddedUpdateId) {
			// Already rolled back to embedded
			const directive = { type: 'noUpdateAvailable' };
			const boundary = '---------------------------' + Date.now().toString(16);
			let signature = '';

			if (c.req.header('expo-expect-signature')) {
				const directiveString = JSON.stringify(directive);
				const hashSignature = await signRSASHA256(directiveString, privateKey);
				const dictionary = convertToDictionaryItemsRepresentation({
					sig: hashSignature,
					keyid: 'main',
				});
				signature = serializeDictionary(dictionary as any);
			}

			const body = `--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n${signature ? `expo-signature: ${signature}\r\n` : ''}\r\n${JSON.stringify(directive)}\r\n--${boundary}--\r\n`;

			return new Response(body, {
				headers: {
					'expo-protocol-version': '1',
					'expo-sfv-version': '0',
					'cache-control': 'private, max-age=0',
					'content-type': `multipart/mixed; boundary=${boundary}`,
				},
			});
		}

		// Return Rollback Directive
		const directive = {
			type: 'rollBackToEmbedded',
			parameters: {
				commitTime: new Date(parseInt(latestTimestamp)).toISOString(),
			},
		};

		let signature = '';
		if (c.req.header('expo-expect-signature')) {
			const directiveString = JSON.stringify(directive);
			const hashSignature = await signRSASHA256(directiveString, privateKey);
			const dictionary = convertToDictionaryItemsRepresentation({
				sig: hashSignature,
				keyid: 'main',
			});
			signature = serializeDictionary(dictionary as any);
		}

		const boundary = '---------------------------' + Date.now().toString(16);
		let body = '';
		body += `--${boundary}\r\n`;
		body += `Content-Disposition: form-data; name="directive"\r\n`;
		body += `Content-Type: application/json; charset=utf-8\r\n`;
		if (signature) {
			body += `expo-signature: ${signature}\r\n`;
		}
		body += `\r\n`;
		body += `${JSON.stringify(directive)}\r\n`;
		body += `--${boundary}--\r\n`;

		return new Response(body, {
			headers: {
				'expo-protocol-version': '1',
				'expo-sfv-version': '0',
				'cache-control': 'private, max-age=0',
				'content-type': `multipart/mixed; boundary=${boundary}`,
			},
		});
	}

	const metadataRes = await c.env.EXPO_UPDATES_BUCKET.get(`${updatePath}/metadata.json`);
	if (!metadataRes) {
		return c.json({ error: 'Metadata not found for the latest update.' }, 404);
	}

	const metadataBuffer = await metadataRes.arrayBuffer();
	const metadataJson = JSON.parse(new TextDecoder().decode(metadataBuffer));
	const updateId = convertSHA256HashToUUID(await createHash(metadataBuffer, 'SHA-256'));

	if (currentUpdateId === updateId && protocolVersion === 1) {
		// Return NoUpdateAvailable directive
		const directive = { type: 'noUpdateAvailable' };
		const boundary = '---------------------------' + Date.now().toString(16);
		let signature = '';

		if (c.req.header('expo-expect-signature')) {
			const directiveString = JSON.stringify(directive);
			const hashSignature = await signRSASHA256(directiveString, privateKey);
			const dictionary = convertToDictionaryItemsRepresentation({
				sig: hashSignature,
				keyid: 'main',
			});
			signature = serializeDictionary(dictionary as any);
		}

		const body = `--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n${signature ? `expo-signature: ${signature}\r\n` : ''}\r\n${JSON.stringify(directive)}\r\n--${boundary}--\r\n`;

		return new Response(body, {
			headers: {
				'expo-protocol-version': '1',
				'expo-sfv-version': '0',
				'cache-control': 'private, max-age=0',
				'content-type': `multipart/mixed; boundary=${boundary}`,
			},
		});
	}

	const expoConfigRes = await c.env.EXPO_UPDATES_BUCKET.get(`${updatePath}/expoConfig.json`);
	const expoConfig = expoConfigRes ? await expoConfigRes.json<any>() : {};

	const platformSpecificMetadata = metadataJson.fileMetadata[platform];
	const baseUrl = new URL(c.req.url).origin;

	const getAssetMetadata = async (filePath: string, ext: string | null, isLaunchAsset: boolean) => {
		const assetRes = await c.env.EXPO_UPDATES_BUCKET.get(`${updatePath}/${filePath}`);
		if (!assetRes) throw new Error(`Asset not found: ${filePath}`);
		const assetData = await assetRes.arrayBuffer();
		const hash = getBase64URLEncoding(await createHash(assetData, 'SHA-256', 'base64'));
		const key = await createHash(assetData, 'MD5');
		const keyExtensionSuffix = isLaunchAsset ? 'bundle' : ext;
		const contentType = isLaunchAsset ? 'application/javascript' : mime.getType(ext!) ?? 'application/octet-stream';

		return {
			hash,
			key,
			fileExtension: `.${keyExtensionSuffix}`,
			contentType,
			url: `${baseUrl}/${projectSlug}/api/assets?asset=${filePath}&runtimeVersion=${runtimeVersion}&platform=${platform}`,
		};
	};

	const manifest = {
		id: updateId,
		createdAt: new Date(parseInt(latestTimestamp)).toISOString(),
		runtimeVersion,
		assets: await Promise.all(
			(platformSpecificMetadata.assets as any[]).map((asset: any) => getAssetMetadata(asset.path, asset.ext, false))
		),
		launchAsset: await getAssetMetadata(platformSpecificMetadata.bundle, null, true),
		metadata: {},
		extra: {
			expoClient: expoConfig,
		},
	};

	let signature = '';
	if (c.req.header('expo-expect-signature')) {
		const manifestString = JSON.stringify(manifest);
		const hashSignature = await signRSASHA256(manifestString, privateKey);
		const dictionary = convertToDictionaryItemsRepresentation({
			sig: hashSignature,
			keyid: 'main',
		});
		signature = serializeDictionary(dictionary as any);
	}

	const assetRequestHeaders: { [key: string]: object } = {};
	[...manifest.assets, manifest.launchAsset].forEach((asset) => {
		assetRequestHeaders[asset.key] = {
			'header-key': 'header-value',
		};
	});

	const boundary = '---------------------------' + Date.now().toString(16);
	
	let body = '';
	body += `--${boundary}\r\n`;
	body += `Content-Disposition: form-data; name="manifest"\r\n`;
	body += `Content-Type: application/json; charset=utf-8\r\n`;
	if (signature) {
		body += `expo-signature: ${signature}\r\n`;
	}
	body += `\r\n`;
	body += `${JSON.stringify(manifest)}\r\n`;

	body += `--${boundary}\r\n`;
	body += `Content-Disposition: form-data; name="extensions"\r\n`;
	body += `Content-Type: application/json\r\n`;
	body += `\r\n`;
	body += `${JSON.stringify({ assetRequestHeaders })}\r\n`;

	body += `--${boundary}--\r\n`;

	c.executionCtx.waitUntil(
		(async () => {
			const clientId = c.req.header('eas-client-id');
			if (!clientId) return;

			const statsKey = `${projectSlug}:stats:installs:${runtimeVersion}:${latestTimestamp}`;
			const seenKey = `${projectSlug}:stats:seen:${runtimeVersion}:${latestTimestamp}:${clientId}`;

			const hasBeenSeen = await c.env.EXPO_UPDATES_KV.get(seenKey);
			if (hasBeenSeen) return;

			// Mark as seen
			await c.env.EXPO_UPDATES_KV.put(seenKey, '1', { expirationTtl: 60 * 60 * 24 * 30 }); // Keep seen record for 30 days

			let count = 0;
			const currentVal = await c.env.EXPO_UPDATES_KV.get(statsKey);
			if (currentVal) {
				count = parseInt(currentVal, 10);
			}
			count++;
			await c.env.EXPO_UPDATES_KV.put(statsKey, count.toString());
		})()
	);
	return new Response(body, {
		headers: {
			'expo-protocol-version': protocolVersion.toString(),
			'expo-sfv-version': '0',
			'cache-control': 'private, max-age=0',
			'content-type': `multipart/mixed; boundary=${boundary}`,
			'content-encoding': 'none',
			'connection': 'keep-alive',
			'keep-alive': 'timeout=5',
		},
	});
});

app.get('/:projectSlug/api/assets', async (c) => {
	const { projectSlug } = c.req.param();
	const assetName = c.req.query('asset');
	const runtimeVersion = c.req.query('runtimeVersion');
	const platform = c.req.query('platform');
	const timestamp = await c.env.EXPO_UPDATES_KV.get(`${projectSlug}:update:${runtimeVersion}:latest`);

	if (!assetName || !runtimeVersion || !platform || !timestamp) {
		return c.json({ error: 'Missing parameters' }, 400);
	}

	const assetPath = `${projectSlug}/updates/${runtimeVersion}/${timestamp}/${assetName}`;
	const assetRes = await c.env.EXPO_UPDATES_BUCKET.get(assetPath);

	if (!assetRes) {
		return c.json({ error: 'Asset not found' }, 404);
	}

	return new Response(await assetRes.arrayBuffer(), {
		headers: {
			'content-type': assetRes?.httpMetadata?.contentType ?? 'application/octet-stream',
		},
	});
});

export default app;
