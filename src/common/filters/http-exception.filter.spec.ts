import { ConflictException, NotFoundException } from '@nestjs/common';
import { GlobalExceptionFilter } from './http-exception.filter';

function buildHost() {
  const json = jest.fn();
  const response = { status: jest.fn().mockReturnThis(), json };
  const request = { method: 'POST', url: '/x' };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as any;
  return { host, response, json };
}

describe('GlobalExceptionFilter', () => {
  it('preserva chaves extras do exception response (ex.: conversationId)', () => {
    const filter = new GlobalExceptionFilter();
    const { host, response, json } = buildHost();

    filter.catch(
      new ConflictException({ message: 'DM já aberta', conversationId: 'conv0' }),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 409,
        message: 'DM já aberta',
        conversationId: 'conv0',
      }),
    );
  });

  it('resposta string não injeta chaves extras', () => {
    const filter = new GlobalExceptionFilter();
    const { host, response, json } = buildHost();

    filter.catch(new NotFoundException('nope'), host);

    expect(response.status).toHaveBeenCalledWith(404);
    const body = json.mock.calls[0][0];
    expect(body.message).toBe('nope');
    expect(Object.keys(body).sort()).toEqual(
      ['error', 'message', 'path', 'statusCode', 'timestamp'].sort(),
    );
  });
});
