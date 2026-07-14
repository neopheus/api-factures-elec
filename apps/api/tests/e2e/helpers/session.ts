import type { INestApplication } from '@nestjs/common'
import request from 'supertest'

export interface Session {
  cookie: string[]
  csrf: string
}

export function extractCookie(setCookie: string[], name: string): string {
  const c = setCookie.find((s) => s.startsWith(`${name}=`))
  if (!c) throw new Error(`cookie ${name} absent`)
  // `c` commence par `${name}=` (garanti par le `.find` ci-dessus) : le split
  // sur ';' contient donc toujours au moins un élément — le `?? c` ne fait
  // que satisfaire `noUncheckedIndexedAccess`, jamais atteint en pratique.
  const pair = c.split(';')[0] ?? c
  return decodeURIComponent(pair.slice(name.length + 1))
}

export async function signupSession(
  app: INestApplication,
  input: unknown,
): Promise<Session> {
  const res = await request(app.getHttpServer())
    .post('/auth/signup')
    .send(input as object)
    .expect(201)
  const setCookie = res.headers['set-cookie'] as unknown as string[]
  return { cookie: setCookie, csrf: extractCookie(setCookie, 'factelec_csrf') }
}
