import { Url } from 'url'

export interface IURL extends Url {
    baseURL: string
    favicon: string | undefined
    isIgnored: boolean
    isStared: boolean
    hasFavicon: boolean
    description: string
}
