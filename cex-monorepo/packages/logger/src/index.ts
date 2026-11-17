import pino from 'pino';

export function createLogger(serviceName: string) {
  return pino({ base: { service: serviceName } });
}
