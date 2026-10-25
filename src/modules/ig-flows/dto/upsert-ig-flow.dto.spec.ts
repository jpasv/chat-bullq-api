import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { UpsertIgFlowDto } from './upsert-ig-flow.dto';

describe('UpsertIgFlowDto', () => {
  it('preserva os nós como objetos com a conversão implícita do ValidationPipe', () => {
    const body = {
      name: 'x',
      triggerType: 'COMMENT',
      startNodeId: 'm1',
      triggerConfig: { keywords: ['motion'] },
      nodes: [{ id: 'm1', type: 'message', text: 'oi', buttons: [{ id: 'b1', title: 'Ir', type: 'url', url: 'https://a' }] }],
    };
    const dto = plainToInstance(UpsertIgFlowDto, body, { enableImplicitConversion: true });
    expect(JSON.parse(JSON.stringify(dto.nodes))).toEqual(body.nodes);
    expect(JSON.parse(JSON.stringify(dto.triggerConfig))).toEqual(body.triggerConfig);
  });
});
