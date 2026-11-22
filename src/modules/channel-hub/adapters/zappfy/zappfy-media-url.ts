/**
 * Links de arquivo da Uazapi (`https://<sub>.uazapi.com/files/<hash>`) são
 * temporários: medido em 2026-11-22, morrem (404) em ~2 dias, e o
 * `/message/download` deixa de achar a mídia depois de ~1 semana. Por isso
 * não servem de cache permanente em `Message.content.mediaUrl` — quem
 * encontrar um desses guardado deve re-hospedar a mídia no nosso disco.
 */
export function isUazapiFileUrl(url: string): boolean {
  return /^https?:\/\/[^/]*uazapi\.com\/files\//i.test(url);
}
