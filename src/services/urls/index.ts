import * as vscode from 'vscode'
import { readdirSync, readFileSync, statSync } from 'fs'
import { extname, join } from 'path'
import { IURL } from './interfaces'
import URL from './models'

import { asyncForEach } from '../../utils'
import { logger } from '../logger'
import { getConfigurations } from '../configurations'
import { getContext } from '../context'

let URLS: IURL[] = []

function cleanURL(url: string) {
    return url.replace(/['"()`´,\\{}<>|^]/g, '').trim()
}

// 我感觉这个插件和 TODO 类似，都是需要遍历文件的，所以这里也可以参考 TODO 的实现。
// https://github.com/Gruntfuggly/todo-tree/blob/master/src/ripgrep.js
// 观察这里 Todo Tree 得到一个结论，他们使用 ripgrep 包装作为文件搜索的工具。
// 实际上 ripgrep 也确实能提供 正则匹配以及文件信息的功能，所以我感觉这里的设计比较不合理。
async function searchForWorkspaceURLs(rootPath = vscode.workspace.rootPath) {
    try {
        if (!rootPath) {
            return undefined
        }

        const configurations = await getConfigurations()
        const { ignorePaths, extensionsList, ignoreDomains } = configurations
        const context = getContext()

        if (!context) {
            return undefined
        }

        // TODO: 实际上 vscode.workspace.fs 也提供了文件读取相关的接口。
        const files = readdirSync(rootPath)
        await asyncForEach(files, async (file: string) => {
            const filePath = join(rootPath, file)
            const stat = statSync(filePath)

            if (ignorePaths.indexOf(file) > -1) {
                logger.log({ message: `File ignored: '${file}'` })
                return
            }

            if (!stat.isDirectory()) {
                const fileExtension = extname(file)
                if (extensionsList.length > 0 && extensionsList.indexOf(fileExtension) === -1) {
                    logger.log({ message: `File extension ignored: '${file}'` })
                    return
                }

                const content = readFileSync(filePath).toString()

                // 对比了一下，我觉得代码应该是来源于：https://stackoverflow.com/questions/3809401/what-is-a-good-regular-expression-to-match-a-url
                // 不知道为什么这个模式会多匹配一个末尾的左括号：
                // 案例：“/// License: MIT (http://www.opensource.org/licenses/mit-license.php)“
                // 然后我就在答主的测试连接里面找到了更好的模式：
                // https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,4}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)
                const urlsFound = content.match(
                    /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/g
                )

                if (urlsFound && urlsFound.length > 0) {
                    await asyncForEach(urlsFound, (url: string) => {
                        const href = cleanURL(url)
                        const urlInstance = new URL(href).url
                        urlInstance.hasFavicon = false

                        if (
                            urlInstance &&
                            urlInstance.host &&
                            ignoreDomains.indexOf(urlInstance.host) === -1
                        ) {
                            URLS.push(urlInstance)
                        }
                    })

                    logger.log({ message: `${urlsFound.length} URL(s) found in "${filePath}".` })
                } else {
                    logger.log({ message: `No URL found in "${filePath}".` })
                }
            } else {
                await searchForWorkspaceURLs(filePath)
            }
        })

        return URLS
    } catch (error) {
        logger.log({ message: `searchForWorkspaceURLs ERROR: ${error.message}` })
        return URLS
    }
}

export const syncURLs = async (showIgnored: boolean) => {
    try {
        const context = getContext()

        if (!context) {
            logger.log({ message: `0 URL(s) found`, shouldSetStatusBarMessage: true })
            return
        }

        URLS = []

        let existentURLs: IURL[] = context.workspaceState.get<IURL[]>('urls') || []

        logger.log({
            message: 'Syncing Project URLs ...',
            shouldSetStatusBarMessage: true,
            shouldClear: true,
        })

        URLS = (await searchForWorkspaceURLs(undefined)) || []

        // ADD URL TO THE existentURLs IF NOT ALREADY EXISTS
        await asyncForEach(URLS, async (urlFound: IURL) => {
            const existent = existentURLs.find((ex) => ex.href === urlFound.href)
            if (!existent && urlFound.host) {
                existentURLs.push(urlFound)
            }
        })

        // REMOVE FROM existentURLs URLs THAT WAS NOT FOUND IN FILES ANYMORE
        await asyncForEach(existentURLs, async (existent: IURL) => {
            const urlFound = URLS.find((ex) => ex.href === existent.href)
            if (!urlFound) {
                existentURLs = existentURLs.filter((ex) => ex.href !== existent.href)
            }
        })

        context.workspaceState.update('urls', existentURLs)

        logger.log({
            message: `${
                existentURLs.filter((ex) => showIgnored || !ex.isIgnored).length
            } URL(s) found`,
            shouldSetStatusBarMessage: true,
        })
    } catch (error) {
        logger.log({ message: `syncURLs ERROR: ${error.message}` })
    }
}

export const getURLs = async (forceSync = false, showIgnored: boolean): Promise<IURL[]> => {
    const context = getContext()

    if (!context) {
        return URLS
    }

    if (forceSync) {
        await syncURLs(showIgnored)
    }

    try {
        const existentURLs = context.workspaceState.get<IURL[]>('urls') || []

        const starredURLs = (existentURLs.filter((ex) => ex.isStarred) || []).sort((a, b) => {
            if (!a.host || !b.host) {
                return 1
            }

            return a.host >= b.host ? 1 : -1
        })
        const notStarredURLs = (existentURLs.filter((ex) => !ex.isStarred) || []).sort((a, b) => {
            if (!a.host || !b.host) {
                return 1
            }

            return a.host >= b.host ? 1 : -1
        })

        return [...starredURLs, ...notStarredURLs].filter((ex) => showIgnored || !ex.isIgnored)
    } catch (error) {
        logger.log({ message: `getURLs ERROR: ${error.message}` })
        return []
    }
}

export const saveURLDescription = async (url: IURL) => {
    const context = getContext()

    if (!context) {
        return
    }

    try {
        const urlsFound: IURL[] = context.workspaceState.get<IURL[]>('urls') || []

        if (urlsFound.length <= 0) {
            return
        }

        await asyncForEach(urlsFound, async (found: IURL) => {
            if (found.href === url.href) {
                found.description = url.description
            }
        })

        context.workspaceState.update('urls', urlsFound)
    } catch (error) {
        logger.log({ message: `saveURLDescription ERROR: ${error.message}` })
    }
}

export const restoreURLFromIgnoreList = async (url: IURL) => {
    const context = getContext()

    if (!context) {
        return
    }

    try {
        const existentURLs: IURL[] = context.workspaceState.get<IURL[]>('urls') || []

        await asyncForEach(existentURLs, async (existent: IURL) => {
            if (existent.href === url.href) {
                existent.isIgnored = false
            }
        })

        context.workspaceState.update('urls', existentURLs)
    } catch (error) {
        logger.log({ message: `restoreURLFromIgnoreList ERROR: ${error.message}` })
    }
}

export const addURLToIgnoreList = async (url: IURL) => {
    const context = getContext()

    if (!context) {
        return
    }

    try {
        const existentURLs: IURL[] = context.workspaceState.get<IURL[]>('urls') || []

        await asyncForEach(existentURLs, async (existent: IURL) => {
            if (existent.href === url.href) {
                existent.isIgnored = true
                existent.isStarred = false
            }
        })

        context.workspaceState.update('urls', existentURLs)
    } catch (error) {
        logger.log({ message: `addURLToIgnoreList ERROR: ${error.message}` })
    }
}

export const restoreURLFromStarredList = async (url: IURL) => {
    const context = getContext()

    if (!context) {
        return
    }

    try {
        const existentURLs: IURL[] = context.workspaceState.get<IURL[]>('urls') || []

        await asyncForEach(existentURLs, async (existent: IURL) => {
            if (existent.href === url.href) {
                existent.isStarred = false
            }
        })

        context.workspaceState.update('urls', existentURLs)
    } catch (error) {
        logger.log({ message: `restoreURLFromIgnoreList ERROR: ${error.message}` })
    }
}

export const addURLToStarredList = async (url: IURL) => {
    const context = getContext()

    if (!context) {
        return
    }

    try {
        const existentURLs: IURL[] = context.workspaceState.get<IURL[]>('urls') || []

        await asyncForEach(existentURLs, async (existent: IURL) => {
            if (existent.href === url.href) {
                existent.isStarred = true
                existent.isIgnored = false
            }
        })

        context.workspaceState.update('urls', existentURLs)
    } catch (error) {
        logger.log({ message: `addURLToIgnoreList ERROR: ${error.message}` })
    }
}
