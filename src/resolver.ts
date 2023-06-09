import {errorsToString, get_data} from "./util";
import {anyDataInstanceType, DevSourceLocationType, DevSourceType} from "./data_types/generic";
import {validation} from "./validate_schemas";
import {InstanceTypeEnum, ModuleTypes, schemaNameMap} from "./const";
import DevHelper from "./dev_helper";
import {getMsg} from "./i18nLLL";
import {ModuleType} from "./data_types/bridge_types";

function getAppPath(only_origin: boolean = false): string {
    const url = new URL(window.location.href)
    // console.log("page url", url)
    const pathParts = url.pathname.split('/')
    pathParts.pop()
    // console.log("put together...", url.origin, pathParts)
    if (only_origin) {
        return url.origin
    } else {
        return url.origin + pathParts.join('/') + "/"
    }
}

function addPrefix(uri: string) {
    let prefix_path = ""
    if (window.getToolkit()) {
        prefix_path = window.getToolkit().processPage.local_prefix_path
        console.debug("addPrefix:", prefix_path, "for uri", uri)
    }
    try {
        new URL(uri)
        console.debug("addPrefix. uri valid", uri)
    } catch (e) {
        // uri is not absolute... add prefix
        if (prefix_path === "" || prefix_path === undefined) {
            prefix_path = getAppPath()
        }
        console.debug("final prefixed uri", prefix_path + uri)
        return prefix_path + uri
    }

    if (!uri.startsWith("http")) {
        uri = getAppPath(uri.startsWith("/")) + uri
    }

    return uri
}

export class LoadsFiles {

    static async loadInstance<Type extends anyDataInstanceType>(source: DevSourceType,
                                                                validate: boolean = true): Promise<Type> {
        let instance: Type
        if (source.uri) {
            // console.log("Loading Instance", source.uri)
            const uri = addPrefix(source.uri)
            try {
                // console.log("prefix_path", prefix_path)
                // console.log("*** ", new URL(source.uri).origin)
                instance = await get_data<Type>(uri)
                // console.debug(source.uri, "DOWNLOADED")
                instance.uri = source.uri
                DevHelper.addSource({...source, instance})
            } catch (e) {
                return Promise.reject(`Failed loading bridge for service ${source.uri}: ${e}`)
            }
        } else if (source.instance) {
            instance = source.instance
        } else {
            // caught with json schema
            return Promise.reject("No uri or schema provided")
        }
        if (validate) {
            // if (!validationParams.schemaName) {
            //     return Promise.reject("No schema!")
            // }
            try {
                console.debug("validating", source.type, schemaNameMap[source.type])
                const validationErrors = validation(schemaNameMap[source.type], instance)
                if (validationErrors.length > 0) {
                    return Promise.reject(`Schema ${source.type} is not valid:\n` +
                        `${errorsToString(validationErrors)}\n`)
                }
            } catch (e) {
                throw `Validation failed: ${e}; ${JSON.stringify(source)}`
            }
        }
        return Promise.resolve(instance)
    }

    static async importModule(moduleUri: string,
                              moduleType: ModuleTypes,
                              location: DevSourceLocationType,
                              moduleName?: string,
                              ignoreUndefined: boolean = true): Promise<ModuleType> {
        if (moduleUri) {
            let uri = addPrefix(moduleUri)
            try {
                console.debug(uri)
                // const module = (await import(uri))
                const module = (await import(/* webpackIgnore: true */uri ))
                console.debug("module loaded: ", moduleName, uri)
                // todo, that is actually strange that I can pass the module as instance
                DevHelper.addSource({
                    type: moduleType,
                    name: moduleName ?? moduleType,
                    uri: moduleUri,
                    instance: module,
                    location
                })
                return module
            } catch (e) {
                console.error(e)
                console.log("****")
                return Promise.reject(getMsg("MODULE_LOAD_FAILED", {moduleName, moduleUri, resolvedUri: uri}))
            }
        } else {
            if (ignoreUndefined) {
                return {}
            } else {
                return Promise.reject(`No module-uri given for: ${moduleName}`)
            }
        }
    }


    private static getInstanceUriPath(fromInstance: InstanceTypeEnum.instanceProcessPage | InstanceTypeEnum.instanceProcess | InstanceTypeEnum.instanceBridge,
                                      type: InstanceTypeEnum,
                                      name?: string
    ): string {
        let basePath: string
        const error_msg = (onlyFor: InstanceTypeEnum[]) => {
            return `Path for ${type} only for  ${onlyFor.join(" & ")} but ${fromInstance} passed`
        }
        switch (type) {
            case InstanceTypeEnum.moduleProcessPage:
                if (fromInstance !== InstanceTypeEnum.instanceProcessPage) {
                    throw new Error(error_msg([InstanceTypeEnum.instanceProcessPage]))
                }
                return "scriptUri"
            case InstanceTypeEnum.instanceProcess:
                if (fromInstance !== InstanceTypeEnum.instanceProcessPage) {
                    throw new Error(error_msg([InstanceTypeEnum.instanceProcessPage]))
                }
                //this.processPageData.process.uri
                return "process.uri"
            case InstanceTypeEnum.moduleProcess:
                basePath = "scriptUri"
                if (InstanceTypeEnum.instanceProcessPage === fromInstance) {
                    return `process.source.instance.${basePath}`
                } else if (InstanceTypeEnum.instanceProcess === fromInstance) {
                    return basePath
                } else {
                    throw new Error(error_msg([InstanceTypeEnum.instanceProcessPage, InstanceTypeEnum.instanceProcess]))
                }
            //this.processPageData.process.instance?.scriptUri
            case InstanceTypeEnum.instanceBridge:
                if ([InstanceTypeEnum.instanceProcessPage, InstanceTypeEnum.instanceProcess].includes(fromInstance)) {
                    return `services.${name}.bridge.source.uri`
                } else {
                    throw new Error(error_msg([InstanceTypeEnum.instanceProcessPage, InstanceTypeEnum.instanceProcess]))
                }
            //this.processPageData.services[name].bridge?.source.uri
            case InstanceTypeEnum.openApi:
                basePath = "execute.openapiSchemaUri"
                if ([InstanceTypeEnum.instanceProcessPage, InstanceTypeEnum.instanceProcess].includes(fromInstance)) {
                    // this.processPageData.services[name].bridge?.source.instance?.execute.openapiSchemaUri
                    return `services${name}.bridge.source.instance.${basePath}`
                } else {
                    return basePath
                }
            case InstanceTypeEnum.moduleBridge:
                basePath = "execute.apiClientModuleUri"
                if ([InstanceTypeEnum.instanceProcessPage, InstanceTypeEnum.instanceProcess].includes(fromInstance)) {
                    // this.processPageData.services[name].bridge?.source.instance?.execute.apiClientModuleUri
                    return `services.${name}.bridge.source.instance.${basePath}`
                } else {
                    return basePath
                }
            case InstanceTypeEnum.moduleBridgeSupport:
                basePath = "supportModuleUri"
                if ([InstanceTypeEnum.instanceProcessPage, InstanceTypeEnum.instanceProcess].includes(fromInstance)) {
                    //this.processPageData.services[name].bridge?.source.instance?.supportModuleUri
                    return `services.${name}.bridge.source.instance.${basePath}`
                } else {
                    return basePath
                }
            default:
                throw new Error(`Unknown instance type: ${type} for ProcessPage`)
        }
    }

    static getSourceLocationDefinition(fromInstance: InstanceTypeEnum.instanceProcessPage | InstanceTypeEnum.instanceProcess | InstanceTypeEnum.instanceBridge,
                                       type: InstanceTypeEnum,
                                       name?: string
    ): DevSourceLocationType {
        return {
            type: fromInstance,
            path: this.getInstanceUriPath(fromInstance, type, name)
        }
    }
}


export interface HasModule {
    hasModuleFunction(functionName: string): boolean

    getModuleFunction(functionName: string): Function
}