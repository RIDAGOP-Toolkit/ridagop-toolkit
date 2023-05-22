import ProcessPage from "./process_page_model";
import cloneDeep from "lodash/cloneDeep"
import {ActivityReferenceType, BasicActivityReferenceType} from "../data_types/ProcessTypes";
import {Store} from "../store_wrapper";
import {ToolkitEventType, ToolkitEventTypeEnum} from "../data_types/generic";

export default class IDS {

    readonly processPage: ProcessPage
    // private store: Store = new Store("Global store")
    private executedActivities: ActivityReferenceType[] = []
    public uiElements: { [id: string]: HTMLElement } = {}
    readonly activityStore: Store = new Store("Activity store")
    readonly eventCallback: Function

    constructor(pp: ProcessPage, eventCallback: Function) {
        this.processPage = pp
        this.eventCallback = eventCallback
    }

    addExecutedActivity(execActivity: ActivityReferenceType) {
        if (!this.isActivityExecuted(execActivity)) {
            this.executedActivities.push(execActivity)
        }
        if (this.eventCallback) {
            const event: ToolkitEventType = {
                type: ToolkitEventTypeEnum.activityCompleted,
                eventData: execActivity
            }
            this.eventCallback(event)
        }
    }

    activityFailed(execActivity: ActivityReferenceType) {
        if (this.eventCallback) {
            const event: ToolkitEventType = {
                type: ToolkitEventTypeEnum.activityFailed,
                eventData: execActivity
            }
            this.eventCallback(event)
        }
    }


    isActivityExecuted(execActivity: BasicActivityReferenceType): boolean {
        // console.log("checking", execActivity)
        // console.log("of..", this.executedActivities)
        for (let eA of this.executedActivities) {
            if (eA.serviceName === execActivity.serviceName
                && eA.activityName === execActivity.activityName)
                return true
        }
        return false
    }

    getAllExecutedActivities(): ActivityReferenceType[] {
        return cloneDeep(this.executedActivities)
    }

    async executeActivity(serviceName: string,
                          activityName: string,
                          params: any[],
                          body?: any,
                          config?: {
                              getParams: boolean
                          }) {
        const activity = this.processPage.process.getActivity({serviceName, activityName})
        if (!activity) {
            const msg = `Service-activity ${serviceName}:${activityName} not found`
            alert(msg)
            throw new Error(msg)
        }
        try {
            return await activity.externalCall(params, body, config)
        } catch (e) {
            throw new Error(`Service-activity ${serviceName}:${activityName} failed: ${e}`)
        }
    }

    /**
     * Get a storage value from the process (when no service name is given) or from a service
     * @param key
     * @param serviceName
     */
    getStorageValue(key: string, serviceName?: string) {
        if (serviceName) {
            console.debug(`Getting stored-value: '${key}' from service: '${serviceName}'`)
            return this.processPage.process.services[serviceName].getStoreValue(key)
        } else {
            return this.processPage.process.getStoreValue(key)
        }
    }

    async getParameterValue(serviceName: string, uiElemName: string) {
        try {
            return await this.processPage.process.services[serviceName].UIElements.getInput(uiElemName).getValue()
        } catch (e) {
            console.error(e)
            console.debug("options are", this.processPage.process.services[serviceName].UIElements.getNames())
            throw new Error(`Service-UIElement ${serviceName}:${uiElemName} failed: ${e}`)
        }
    }

}

export function getIDS(): IDS {
    return window.__IDS_GLOBALS__
}

export function setIDS(ids_object: IDS) {
    window.__IDS_GLOBALS__ = ids_object
}

