import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import worker from '../src/index';

// Mock Data
const RUNTIME_VERSION = '1';
const TIMESTAMP = '1672531200000'; // Mock timestamp
const UPDATE_ID = '00000000-0000-0000-0000-000000000000'; // Expected UUID from hashed empty metadata
const ASSET_PATH = 'assets/test.js';
const ASSET_CONTENT = 'console.log("test");';

// Generated RSA 2048 key for testing
const TEST_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEApz+RyTxZKO59m0mBLcZoKO94ROdIB5smWsldnUBrdaLwx916
81nPsYpVocEf5SSFt8qDTRJ/SQzgr3wl+hdHSFYCCPPnaKFJ4SVcLHzmSldmrUDP
kOPeLItj7yvI4qAkfZpSUhqSG1vcKosV75b08oa4lqG08R80gj9mh6h2fjzg74nb
5n9zISI55pB+vX1NHrZ90jI8HnyLyIPyleXI4QFwcrmqtw7O6K0HRdaktppUO3/7
2ome7azfpWnQjdtRhLgUvEuaZgJbtOmA80Mo9pmZ2IahxZbIKHwBQgVqnv1TacxN
+jrQqyBHfBMiTjiKgvsegXjqYyCWe3NJYKwMUwIDAQABAoIBAQCaSr8H0zC93ibq
l4kg3aVB/ooJpwSAX9Wmc5Z1d/Sq9cMD34OJ9RTySRhuvWfbUTI7OAyhkarzjXnK
6tFuQwNz7ES8Vabqk8FAf+Lk9+TMOI100BGtLUrN9VogT1hoGi0P4sqHDBQ2QSx/
4wg9nBolk7u+2ze+KneaoTrJc9S855chY//9HhwS6D/B6llmyB3nyif7XfzhG6RB
c5fK0MJQXDdDGAmXUX2OZQXj9qwlWoszh3QuLh+8l6iOk8vx9bn+Le4clswzWH9H
kGMUo/km62wZLUVXbxfg4hUYRJ9oTw1j9ebYufK2ahSbG9UweZ42VG6sa9e/+BHo
Nr2gvhghAoGBANARW0BUSdtO0tC5HjUHZeM7JcuouF/bxVid36XmQ0vKQNwFghAT
0ZctUQdhMA24x4xlPiZnOimYDQQ6vqEtZb+ynItiRhLRR0JQJ/9+V7ZIMCBbU9kI
+HWTTVO/oZHncpX1xPHwmMZXMqlS2tCxjE8rA3HPfNL/dzBSwuzKNQUXAoGBAM3G
6iBViGRhTm8lpYZSyNLqHpf0TZHPaFYV7b/P9vtMHAX1AKzQRyw/y1uiv0iBlJYV
sPUdiFdLQvzXKhlRT4ebtPLxKXMCtzFO3/sTXh6ckzpc7Y19Iy2KwgULuTFK5hcN
nWQSTR8bl82Yk+UYtMYFwwwyx1DFpFgMo4hfIjAlAoGAQMg2pifYOw0mvE/25MHh
6kb/NJLanRX7MuUsviWcbFuTqC2a2lChYDV+1hJfeNZAYykemaxoQo0R+HAl7F8L
IA2HiipV8QPx8OauHXGD88A0I87ro1aUrV7oo5u1vYzXc3NrF302xAJgRrICaRnu
urOExgm5LqTVwljyUfF/Yo8CgYBR7amX2BYmySs+S4Hcuick+nvVyjn8HNUQuUhg
fz95jDL4GDT9mStNLdUcle6MwrLTEq3S2cBH6ToxisVDMUF134Oq2mPDW8huRFYf
E/X8QCDKMueN1s3juwRGmAVS39w+P3hzuGmmQgktnVr88to+oVqoB6uduCMXv2h4
yk/FVQKBgQCHEok6M7z4TRar3gy3aIlz3wcll5ZsbRCMpuzgcLsfANNxpfSnIygi
cnYLCB+Fwj4YPN6Vno8hPZUiD/Uz11LRc80gWbiVRgNVfmbF9PEEXVh07bxaOiRt
W1EB3dKuonFbXtd/av+6gGE4AAkaIdIvfIduR9HlUDMBboPziJjroQ==
-----END RSA PRIVATE KEY-----`;

describe('Expo Updates API Worker', () => {
	beforeAll(async () => {
		// Setup KV
		await env.EXPO_UPDATES_KV.put(`update:${RUNTIME_VERSION}:latest`, TIMESTAMP);
		
		// Setup R2
		const metadata = {
			fileMetadata: {
				ios: {
					assets: [{ path: ASSET_PATH, ext: 'js' }],
					bundle: ASSET_PATH,
				},
				android: {
					assets: [],
					bundle: ASSET_PATH,
				},
			},
		};
		const encoder = new TextEncoder();
		const metadataBuffer = encoder.encode(JSON.stringify(metadata));
		
		await env.EXPO_UPDATES_BUCKET.put(`updates/${RUNTIME_VERSION}/${TIMESTAMP}/metadata.json`, metadataBuffer);
		await env.EXPO_UPDATES_BUCKET.put(`updates/${RUNTIME_VERSION}/${TIMESTAMP}/${ASSET_PATH}`, encoder.encode(ASSET_CONTENT), {
			httpMetadata: { contentType: 'application/javascript' },
		});
	});

	it('returns 400 if platform header is missing', async () => {
		const request = new Request('http://example.com/api/manifest', {
			headers: { 'expo-protocol-version': '1' },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'Unsupported platform. Expected either ios or android.' });
	});

	it('returns 404 if no update found', async () => {
		const request = new Request('http://example.com/api/manifest', {
			headers: {
				'expo-protocol-version': '1',
				'expo-platform': 'ios',
				'expo-runtime-version': '999', // Non-existent version
			},
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		expect(response.status).toBe(404);
	});

	it('returns a valid manifest with signature', async () => {
		const request = new Request('http://example.com/api/manifest', {
			headers: {
				'expo-protocol-version': '1',
				'expo-platform': 'ios',
				'expo-runtime-version': RUNTIME_VERSION,
				'expo-expect-signature': 'true',
				'eas-client-id': 'test-client-1',
			},
		});
		
		// Inject Private Key
		const testEnv = { ...env, EXPO_UPDATES_PRIVATE_KEY: TEST_PRIVATE_KEY };
		const ctx = createExecutionContext();
		
		const response = await worker.fetch(request, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const text = await response.text();
		
		// Verify Multipart Response
		expect(text).toContain('Content-Type: application/json');
		expect(text).toContain('expo-signature');
		expect(text).toContain(new Date(parseInt(TIMESTAMP)).toISOString()); // Creation date based on timestamp
		
		// Verify KV Increment
		const stats = await env.EXPO_UPDATES_KV.get(`stats:installs:${RUNTIME_VERSION}:${TIMESTAMP}`);
		expect(stats).toBe('1');
	});

	it('tracks unique installs correctly', async () => {
		const clientId = 'client-123';
		const request = new Request('http://example.com/api/manifest', {
			headers: {
				'expo-protocol-version': '1',
				'expo-platform': 'ios',
				'expo-runtime-version': RUNTIME_VERSION,
				'expo-expect-signature': 'true',
				'eas-client-id': clientId,
			},
		});
		
		const testEnv = { ...env, EXPO_UPDATES_PRIVATE_KEY: TEST_PRIVATE_KEY };
		const ctx1 = createExecutionContext();
		
		// First request: Should increment
		const res1 = await worker.fetch(request.clone(), testEnv, ctx1);
		await waitOnExecutionContext(ctx1);
		expect(res1.status).toBe(200);

		const ctx2 = createExecutionContext();
		// Second request: Should NOT increment
		const res2 = await worker.fetch(request.clone(), testEnv, ctx2);
		await waitOnExecutionContext(ctx2);
		expect(res2.status).toBe(200);

		// Verify KV Increment
		const stats = await env.EXPO_UPDATES_KV.get(`stats:installs:${RUNTIME_VERSION}:${TIMESTAMP}`);
		// Expect 1 because test environment likely resets or isolates state.
		expect(stats).toBe('1');
	});

	it('returns NoUpdateAvailable when up to date', async () => {
		const testEnv = { ...env, EXPO_UPDATES_PRIVATE_KEY: TEST_PRIVATE_KEY };
		const preReq = new Request('http://example.com/api/manifest', {
			headers: {
				'expo-protocol-version': '1',
				'expo-platform': 'ios',
				'expo-runtime-version': RUNTIME_VERSION,
				'eas-client-id': 'test-client-2',
			},
		});
		const preRes = await worker.fetch(preReq, testEnv, createExecutionContext());
		const preText = await preRes.text();
		const match = preText.match(/"id":"([a-f0-9-]+)"/);
		const updateId = match ? match[1] : null;
		
		expect(updateId).toBeTruthy();

		// Now request with that ID
		const request = new Request('http://example.com/api/manifest', {
			headers: {
				'expo-protocol-version': '1',
				'expo-platform': 'ios',
				'expo-runtime-version': RUNTIME_VERSION,
				'expo-current-update-id': updateId!,
				'expo-expect-signature': 'true',
				'eas-client-id': 'test-client-2',
			},
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, testEnv, ctx);
		
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain('noUpdateAvailable');
	});

	it('serves assets correctly', async () => {
		const url = `http://example.com/api/assets?asset=${ASSET_PATH}&runtimeVersion=${RUNTIME_VERSION}&platform=ios&timestamp=${TIMESTAMP}`;
		const request = new Request(url);
		const ctx = createExecutionContext();
		
		const response = await worker.fetch(request, env, ctx);
		
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(ASSET_CONTENT);
		expect(response.headers.get('content-type')).toContain('javascript');
	});

	describe('Rollback', () => {
		const ROLLBACK_RUNTIME_VERSION = '2';
		const ROLLBACK_TIMESTAMP = '1672531300000';

		beforeAll(async () => {
			await env.EXPO_UPDATES_KV.put(`update:${ROLLBACK_RUNTIME_VERSION}:latest`, ROLLBACK_TIMESTAMP);
			await env.EXPO_UPDATES_BUCKET.put(`updates/${ROLLBACK_RUNTIME_VERSION}/${ROLLBACK_TIMESTAMP}/rollback`, '');
		});

		it('returns 400 if protocol version is 0 for rollback', async () => {
			const request = new Request('http://example.com/api/manifest', {
				headers: {
					'expo-protocol-version': '0',
					'expo-platform': 'ios',
					'expo-runtime-version': ROLLBACK_RUNTIME_VERSION,
				},
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: 'Rollbacks not supported on protocol version 0' });
		});

		it('returns 400 if expo-embedded-update-id header is missing for rollback', async () => {
			const request = new Request('http://example.com/api/manifest', {
				headers: {
					'expo-protocol-version': '1',
					'expo-platform': 'ios',
					'expo-runtime-version': ROLLBACK_RUNTIME_VERSION,
				},
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: 'Invalid Expo-Embedded-Update-ID request header specified.' });
		});

		it('returns a rollback directive', async () => {
			const request = new Request('http://example.com/api/manifest', {
				headers: {
					'expo-protocol-version': '1',
					'expo-platform': 'ios',
					'expo-runtime-version': ROLLBACK_RUNTIME_VERSION,
					'expo-embedded-update-id': 'embedded-id-123',
					'expo-expect-signature': 'true',
				},
			});
			const testEnv = { ...env, EXPO_UPDATES_PRIVATE_KEY: TEST_PRIVATE_KEY };
			const ctx = createExecutionContext();
			
			const response = await worker.fetch(request, testEnv, ctx);
			expect(response.status).toBe(200);
			
			const text = await response.text();
			expect(text).toContain('rollBackToEmbedded');
			expect(text).toContain(new Date(parseInt(ROLLBACK_TIMESTAMP)).toISOString());
			expect(text).toContain('expo-signature');
		});

		it('returns NoUpdateAvailable if already on embedded update', async () => {
			const request = new Request('http://example.com/api/manifest', {
				headers: {
					'expo-protocol-version': '1',
					'expo-platform': 'ios',
					'expo-runtime-version': ROLLBACK_RUNTIME_VERSION,
					'expo-embedded-update-id': 'embedded-id-123',
					'expo-current-update-id': 'embedded-id-123',
					'expo-expect-signature': 'true',
				},
			});
			const testEnv = { ...env, EXPO_UPDATES_PRIVATE_KEY: TEST_PRIVATE_KEY };
			const ctx = createExecutionContext();
			
			const response = await worker.fetch(request, testEnv, ctx);
			expect(response.status).toBe(200);
			
			const text = await response.text();
			expect(text).toContain('noUpdateAvailable');
		});
	});
});