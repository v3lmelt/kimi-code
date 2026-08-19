import { describe, expect, it } from 'vitest';

import { openUrlCommand } from '#/utils/open-url';

describe('openUrlCommand', () => {
  it('passes a Windows URL with query parameters directly to the protocol handler', () => {
    const url =
      'https://auth.openai.com/oauth/authorize?response_type=code&client_id=example&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback';

    expect(openUrlCommand(url, 'win32')).toEqual({
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', url],
    });
  });
});
