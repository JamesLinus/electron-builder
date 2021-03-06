import { IncomingMessage, ClientRequest, Agent } from "http"
import * as https from "https"
import { ensureDir, readFile } from "fs-extra-p"
import BluebirdPromise from "bluebird-lst-c"
import * as path from "path"
import { homedir } from "os"
import { parse as parseIni } from "ini"
import { HttpExecutor, DownloadOptions, configureRequestOptions } from "electron-builder-http"
import { RequestOptions } from "https"
import { parse as parseUrl } from "url"

export class NodeHttpExecutor extends HttpExecutor<RequestOptions, ClientRequest> {
  private httpsAgentPromise: Promise<Agent> | null

  async download(url: string, destination: string, options?: DownloadOptions | null): Promise<string> {
    if (options == null || !options.skipDirCreation) {
      await ensureDir(path.dirname(destination))
    }

    if (this.httpsAgentPromise == null) {
      this.httpsAgentPromise = createAgent()
    }

    const agent = await this.httpsAgentPromise
    return await new BluebirdPromise<string>((resolve, reject) => {
      const parsedUrl = parseUrl(url)
      this.doDownload(configureRequestOptions({
        hostname: parsedUrl.hostname,
        path: parsedUrl.path,
        headers: (options == null ? null : options.headers) || undefined,
        agent: agent,
      }), destination, 0, options || {}, (error: Error) => {
        if (error == null) {
          resolve(destination)
        }
        else {
          reject(error)
        }
      })
    })
  }

  doApiRequest<T>(options: RequestOptions, requestProcessor: (request: ClientRequest, reject: (error: Error) => void) => void, redirectCount: number = 0): Promise<T> {
    if (this.debug.enabled) {
      this.debug(`HTTPS request: ${JSON.stringify(options, null, 2)}`)
    }

    return new BluebirdPromise<T>((resolve, reject, onCancel) => {
      const request = https.request(options, (response: IncomingMessage) => {
        try {
          this.handleResponse(response, options, resolve, reject, redirectCount, requestProcessor)
        }
        catch (e) {
          reject(e)
        }
      })
      this.addTimeOutHandler(request, reject)
      request.on("error", reject)
      requestProcessor(request, reject)
      onCancel!(() => request.abort())
    })
  }


  protected doRequest(options: any, callback: (response: any) => void): any {
    return https.request(options, callback)
  }
}

export const httpExecutor: NodeHttpExecutor = new NodeHttpExecutor()

// only https proxy
async function proxyFromNpm() {
  let data = ""
  try {
    data = await readFile(path.join(homedir(), ".npmrc"), "utf-8")
  }
  catch (ignored) {
    return null
  }

  if (!data) {
    return null
  }

  try {
    const config = parseIni(data)
    return config["https-proxy"] || config.proxy
  }
  catch (e) {
    // used in nsis auto-updater, do not use .util.warn here
    console.warn(e)
    return null
  }
}

// only https url
async function createAgent() {
  let proxyString: string =
    process.env.npm_config_https_proxy ||
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.npm_config_proxy

  if (!proxyString) {
    proxyString = await proxyFromNpm()
    if (!proxyString) {
      return null
    }
  }

  const proxy = parseUrl(proxyString)

  const proxyProtocol = proxy.protocol === "https:" ? "Https" : "Http"
  return require("tunnel-agent")[`httpsOver${proxyProtocol}`]({
    proxy: {
      port: proxy.port || (proxyProtocol === "Https" ? 443 : 80),
      host: proxy.hostname,
      proxyAuth: proxy.auth
    }
  })
}

