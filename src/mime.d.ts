declare module "mime" {
  interface MimeApi {
    getType(path: string): string | null;
  }

  const mime: MimeApi;
  export default mime;
}
