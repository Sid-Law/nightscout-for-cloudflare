declare module "csv-stringify/lib/sync.js" {
  interface CsvStringifyOptions {
    header?: boolean;
  }

  export default function csvStringifySync(
    records: unknown[],
    options?: CsvStringifyOptions,
  ): string;
}

declare module "easyxml" {
  interface EasyXmlOptions {
    rootElement?: string;
    dateFormat?: "ISO" | "SQL" | "JS";
    manifest?: boolean;
  }

  export default class EasyXml {
    constructor(options?: EasyXmlOptions);
    render(value: unknown): string;
  }
}
