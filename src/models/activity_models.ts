import {BaseService} from "./base_service";
import {
    ActivityReferenceType,
    ProcessParamType,
    ProcessServiceActivityType,
    RequiredActivityType
} from "../data_types/ProcessTypes";
import {Bridge, ExecutionType} from "./bridge_models";
import {ActivityParameter, UIInput} from "./parameter_models";
import {NodeType, PreProcessErrorCancelCommand, ServiceTypeEnum} from "../const";
import {getMsg} from "../i18nLLL";
import {addToOpenInputs, buildDynamicUI, outputHtml} from "../ui";
import {Service} from "./service_model";
import isEmpty from "lodash/isEmpty";
import size from "lodash/size";
import isEqual from "lodash/isEqual";
import {getToolkit} from "./tk_model";
import {ActivityExecution, ModuleFunction, ReferenceActivity} from "./activity_execution_models";
import {StoreContextEnum} from "../store_wrapper";

export enum ActivityErrorType {
    requiredActivitiesNotExecuted,
    parametersError, // atm not used
    executionFailed // atm not used
}

export class ActivityError {

    readonly service: string
    readonly activity: string
    readonly type: ActivityErrorType
    readonly message: string

    constructor(service: string, activity: string, type: number, message: string) {
        this.service = service
        this.activity = activity
        this.type = type
        this.message = message
    }
}

export class Activity {

    readonly service: BaseService<any>
    readonly parentActivity?: Activity
    readonly name: string
    readonly title: string
    private readonly data: ProcessServiceActivityType | ActivityReferenceType

    // private readonly bridgeCapability: BridgeCapability
    private preProcess?: ModuleFunction
    private execution: ActivityExecution
    public parameters: { [paramName: string]: ActivityParameter } = {}
    public dynamicParameters: { [paramName: string]: ProcessParamType } = {}
    public requestBody: { [partName: string]: ActivityParameter } = {}

    private readonly requiredActivities: RequiredActivityType[] = []
    // private readonly storeResultSettings: { context: StoreContextEnum, key: string }
    public subActivities: { [activityName: string]: Activity } = {}
    public subActivitiesOrder: string[] = []
    private active: boolean = true // might be inactive because execution not found
    //
    node_id: string = ""

    constructor(name: string,
                service: BaseService<any>,
                activityData: ProcessServiceActivityType | ActivityReferenceType,
                parentActivity?: Activity) {


        this.name = name
        this.service = service
        this.data = activityData

        this.title = activityData.title
        // only not references
        // todo, strange...
        if (this.isActivityReference()) {
            const activityData_ = activityData as unknown as ProcessServiceActivityType
            // this.storeResult = activityData_.storeResult
            this.requiredActivities = activityData_.requiredActivities || []
        }

        // a requiredActivity of the same Service...
        this.requiredActivities.forEach(rA => {
            rA.serviceName = rA.serviceName || this.service.name
        })

        this.parentActivity = parentActivity

        try {
            if (this.isActivityReference()) {
                this.setupReferenceExecution()
            } else {
                this.setupExecution()
            }
            this.setupPreProcessExecution()
        } catch (e) {
            this.active = false
            throw `${this.toString()} Setting execution failed. ${e}`
            // console.error()
        }

        const edges: { dest: string, props: object }[] = []
        if (this.parentActivity) {
            edges.push({dest: this.parentActivity.node_id, props: {type: "parent"}})
        } else {
            edges.push({dest: this.service.node_id, props: {type: "service"}})
        }
        this.node_id = getToolkit().register_node(this.name, this.title, NodeType.activity, edges)
    }

    toString() {
        return `[Activity ${this.service.title}:${this.title}]`
    }

    /**
     *
     * @param functionName
     * @param context activity execution (preProcess). just for error-logging
     */
    fromModuleFunction(functionName: string, context: string = ""): ModuleFunction {
        // console.log("... module")
        const process = this.service.getProcess()
        if (process.hasModuleFunction(functionName)) {
            const function_: Function = process.getModuleFunction(functionName)
            const functionSource = process.module.srcMap[functionName]
            return new ModuleFunction(function_, functionSource)
        } else if (!this.service.isProcess() && (this.service as Service).bridge.hasModuleFunction(functionName)) {
            const bridge = (this.service as Service).bridge
            console.log("coool")
            const function_: Function = bridge.getModuleFunction(functionName)
            const functionSource = bridge.supportModule.srcMap[functionName]
            return new ModuleFunction(function_, functionSource)
        } else {
            console.error(`no module function in service/page module for ${context} Activity: '${this.name}'. Name of Function: ${functionName}`)
            console.error(this.service.getProcess().module.listFunctions())
            this.active = false
            throw(getMsg("MODULE_FUNCTION_NOT_FOUND", {functionName: functionName}))
        }
    }

    setupExecution() {
        /**
         * Retrieve the execution Capability from the bridge. The capability is wrapping either a
         */
        let bridge: Bridge<any>
        // only for process(lookup activity in service)
        // console.log("SET-EXEC", this.service.name, this.name, this.data)

        const activityData = this.data as ProcessServiceActivityType
        let capability
        // debugger

        if (activityData.bridgeCapability) {
            // console.log("... bridge")
            if (this.service.serviceType === ServiceTypeEnum.service) {
                bridge = (this.service as Service).bridge
                capability = bridge.getCapability(activityData.bridgeCapability)
                this.execution = capability
                this.active = capability.active
            } else {
                // create errorMsg log it and throw error
                const errorMsg = "bridgeCapability is only allowed for services, not for process"
                console.error(errorMsg)
                throw(errorMsg)
            }
            // console.log("bridge-capability", bridgeCapability)
        } else if (activityData.moduleFunction) { // moduleFunction
            this.execution = this.fromModuleFunction(activityData.moduleFunction)
        } else {
            console.error("No execution found for Activity", this.name, this.data)
        }
        // console.log(this.title, this.execution)
        // todo needed our caught earlier?
        if (!this.execution) {
            console.error("Something went wrong. No capability for Activity", this.name, this.data)
            // if (bridge)
            //     console.error("options would be", bridge.capabilities)
            this.active = false
            return
        }
    }

    setupReferenceExecution() {
        // console.log("... reference")
        const data = this.data as ActivityReferenceType
        const activity = this.service.getActivity(data)
        if (activity) {
            this.execution = new ReferenceActivity(activity)
        } else {
            throw new Error(`Reference-Activity '${this.service.name}.${this.name}' references to 
                a service that does not exist ${data.serviceName}`)
        }
    }

    setupPreProcessExecution() {
        const activityData = this.data as ProcessServiceActivityType
        if (activityData.preProcess) {
            const preProcessFunctionName = activityData.preProcess
            this.preProcess = this.fromModuleFunction(preProcessFunctionName, "preProcess")
            if (!isEqual(this.preProcess.getParameterNames(), this.execution.getParameterNames())) {
                console.error(`${this.service.name}: preProcessFunction ${preProcessFunctionName} has different parameters than 
                    the execution of the activity ${this.name}`)
                console.error(
                    "preProcessFunction", this.preProcess.getParameterNames(),
                    "execution", this.execution.getParameterNames())
            }

        }
    }

    mapParameters(
        processParamMapping: object = {},
        processPageParamMapping: object = {},
        uiInputs: { [inputName: string]: UIInput }) {
        /**
         * What is it currently doing:
         * 1. Get the parameters from the execution
         * 2. get the parameters from the activity definition
         * Check if their length is the same. If not warning!
         * Repeat for each parameter of the execution
         *  - check if the parameter is mapped in the process-page, if yes: check if there is an input-field OK
         *  - check if there is an automatic mapping inputfieldName == parameterName
         *  - use given parameter type...
         *
         *  Run same for all subActivities
         */
        if (!this.active) {
            console.error(`No Parameter-mapping is done for inactive Activity: '${this.name}' of service: '${this.service.name}'`)
            return
        }
        if (this.execution.getExecutionType() === ExecutionType.referenceActivity) {
            // no mapping for reference activities
            // but still do the subActivities
            for (let subActivity of Object.values(this.subActivities)) {
                subActivity.mapParameters(processParamMapping, processPageParamMapping, uiInputs)
            }
            return
        }
        const executionParameters = this.execution.getParameterNames()
        // console.log(executionParameters)
        const activityData = this.data as ProcessServiceActivityType
        const activityParamDef = activityData.parameters || {}
        // console.log(this.data.parameters || {})
        console.debug(`*** ParameterMapping ${this.name} ***`)
        for (let executionParameter of executionParameters) {
            console.debug(`* ${executionParameter} *`)

            // 1. look if there is a definition in the activity,
            // it has priority to definitions in the process/process-page
            const paramDef = activityParamDef[executionParameter]
            if (paramDef) {
                if (paramDef.dynamic) {
                    console.debug("Ignoring dynamic parameter: ", executionParameter)
                    this.dynamicParameters[executionParameter] = paramDef
                    continue
                }
                const param = ActivityParameter.getActivityParameter(this, paramDef, uiInputs, executionParameter)
                if (param) {
                    this.parameters[executionParameter] = param
                    console.debug(`Parameter: '${executionParameter}' mapped: ${this.parameters[executionParameter].description()}`)
                    continue
                } else {
                    console.error(`Invalid definition for parameter: ${executionParameter}, ${paramDef}`)
                }
            }

            // search in process-page/process
            const findInCollection = (collectionName: string, collection: object) => {
                if (executionParameter in collection) {
                    const paramDef = collection[executionParameter]
                    const param = ActivityParameter.getActivityParameter(this, paramDef, uiInputs, executionParameter)
                    if (param) {
                        this.parameters[executionParameter] = param
                        console.debug(`Parameter: '${executionParameter}' mapped to a ${collectionName}
                         parameter: ${this.parameters[executionParameter].description()}`)
                        return true
                    } else {
                        console.error(`Parameter: '${executionParameter}' could not be mapped to a ${collectionName}
                        parameter: ${JSON.stringify(paramDef)} for service:activity '${this.service.name}:${this.name}'`)
                    }
                }
                return false
            }

            // console.log(executionParameter, processPageParamMapping, processParamMapping)
            if (findInCollection("process-page", processPageParamMapping))
                continue
            if (findInCollection("process", processParamMapping))
                continue

            // this is an automatic mapping from an 'executionParameter' parameter to an input of the same name
            if (executionParameter in uiInputs) {
                // console.log("direct mapping")
                this.parameters[executionParameter] = uiInputs[executionParameter]
                console.debug(`Parameter: '${executionParameter}' directly mapped to ui-element: ${this.parameters[executionParameter].description()}`)
                continue
            }

            // console.warn(`No mapping for Activity parameter: '${executionParameter}'
            // of service:activity: '${this.service.title}:${this.title}'`)
            // console.warn("Given activity-parameters", Object.keys(activityParamDef))
            // continue
            console.error(`Missing ActivityParameter: '${executionParameter}' of activity: ${this.name}`)
        }

        // add mapping for requestBody
        const execType = this.execution.getExecutionType()
        // todo : maybe referenceActivity as well
        if (activityData.requestBody && execType === ExecutionType.openApiMethod) {
            // console.error("requestBody", activityData.requestBody)
            this.requestBody = {}
            for (let [key, requestBodyDef] of Object.entries(activityData.requestBody)) {
                const bodyParam = ActivityParameter.getActivityParameter(this, requestBodyDef, uiInputs, key)
                // console.log(this.name, "bodyParam", bodyParam)
                if (bodyParam) {
                    this.requestBody[key] = bodyParam
                }
            }
        }

        for (let subActivity of Object.values(this.subActivities)) {
            subActivity.mapParameters(processParamMapping, processPageParamMapping, uiInputs)
        }

        for (let paramDefName of Object.keys(activityParamDef)) {
            if (!executionParameters.includes(paramDefName)) {
                console.info(`Activity: ${this.name} defines parameter: ${paramDefName} which is not required
                by the execution`)
            }
        }
    }

    async getRequestBody(parentResult?: any): Promise<any> {
        let requestBody
        if (!isEmpty(this.requestBody)) {
            requestBody = {}
            if (this.requestBody.data) {
                // todo maybe this can go into the json-schema
                if (size(this.requestBody) > 1) {
                    console.warn("There should be no other key, when 'data' is present")
                }
                requestBody = await this.requestBody.data.getValue(parentResult)
            } else {
                for (let [key, parameter] of Object.entries(this.requestBody)) {
                    requestBody[key] = await parameter.getValue()
                }
            }
        }
        return Promise.resolve(requestBody)
    }

    /**
     *
     * @param parentResult
     * @param previousActivityResult
     * @param config
     */
    async execute(parentResult?: any, previousActivityResult?: any, config?: ActivityConfig): Promise<any> {
        /**
         * Execute the activity:
         * steps:
         * 1. check if all required activities ('requiredActivities') have been executed
         * 2. collect parameters values
         * 3. Execute bridge activity (either openapi call, or module-function)
         * 4. Store result in cache or global storage
         * 5. check and execute sub-activities
         * 6. potentially create some dynamic UI
         * 7. add this activity to executed activities
         */
            // console.log("execute", this.name)
        let debugSkipExec = false
        if (!(this.data?.debug?.execute ?? true)) {
            console.debug("DEBUG execute: ", this.name, "skipped")
            debugSkipExec = true
        }
        if (!this.active) {
            return Promise.reject("Activity not active")
        }
        // 1. check if all required activities ('requiredActivities') have been executed
        // console.debug(`exec: ${this.name} 1`)
        console.debug(`*** Execute Activity: ${this.name} *** `)
        for (let requiredActivity of this.requiredActivities) {
            if (!getToolkit().isActivityExecuted(requiredActivity)) {
                console.error("Required Activity not executed", requiredActivity.activityName)
                // const activityTitle = this.service.getProcess().getActivity(requiredActivity).title
                const activityTitle = getToolkit().processPage.process.getActivity(requiredActivity).title
                let errorMsg: string
                if (requiredActivity.errorMessage) {
                    errorMsg = requiredActivity.errorMessage
                } else {
                    errorMsg = getMsg("OTHER_ACTIVITY_REQUIRED",
                        {requiredActivity: activityTitle, serviceName: this.service.title})
                }
                this.service.activityError(new ActivityError(
                    this.service.title, this.title,
                    ActivityErrorType.requiredActivitiesNotExecuted, `${this.title}: failed: ${errorMsg}`))
                return Promise.reject(errorMsg)
            }
        }
        // console.debug(`exec: ${this.name} 2`)
        // 2. collect parameters values
        // console.log("this.params", this.parameters)
        const parameters = await this.getParameterValues(parentResult, previousActivityResult)
        console.debug("parameters", parameters, "<-", this.parameters)

        let requestBody = await this.getRequestBody(parentResult)
        // console.error("requestBody", this.requestBody)

        if (this.preProcess) {
            try {
                const preProcResult = await this.preProcess.execute(parameters, requestBody)
                if (preProcResult) {
                    if (typeof preProcResult === "object") {
                        for (let [k, v] of Object.entries(preProcResult)) {
                            parameters[k] = v
                        }
                    }
                }
            } catch (e) {
                if (e.cause === PreProcessErrorCancelCommand) {
                    console.info("PreProcess cancelled execution of activity", this.name)
                    return await Promise.resolve()
                } else {
                    return Promise.reject(`PreProcess failed ${e}; ${this.preProcess}`)
                }
            }
        }
        // 3. Execute activity (either bridge.openapi call, bridge.module-function or process.module-function)
        let result
        //
        if (!debugSkipExec) {
            result = await this.callExec(parameters, requestBody)
        } else {
            if (this.data?.debug?.resultData) {
                result = this.data.debug.resultData
            } else {
                result = {}
            }
        }
        console.debug(`${this.name}:result`, result)
        // console.debug(`exec: ${this.name} 4`)
        // 4. Store result in cache or global storage
        // duplicate code in other bridge type
        this.storeResult(result)

        // console.debug(`exec: ${this.name} 5`)
        // 5. check and execute sub-activities
        console.debug(`${this.name}:SubActivities`, Object.keys(this.subActivities))
        let previousSubActivityResult = undefined
        for (let orderedSubActivityName of this.subActivitiesOrder) {
            try {
                previousSubActivityResult = await this.subActivities[orderedSubActivityName].execute(result, previousSubActivityResult)
            } catch (error) {
                await Promise.reject(getMsg("SUB-ACTIVITY_FAILED", {error}))
            }
        }

        // 6. potentially create some outputHtml and dynamic UI
        console.debug(`${this.name}:ui: `, this.activityData().ui)
        this.handleSpecialResult(result)

        // console.log(this.name, this.parentActivity?.name, this.parentActivity === undefined)
        // debugger
        if (this.parentActivity === undefined &&
            this.execution.getExecutionType() !== ExecutionType.referenceActivity &&
            (this.activityData().ui?.alert ?? true) &&
            (config?.alert ?? false)) {
            alert("Activity executed: " + this.title)
        }
        // console.debug(`exec: ${this.name} 7`)
        // 7. add this activity to executed activities
        getToolkit().addExecutedActivity({
            title: this.title,
            serviceName: this.service.name,
            activityName: this.name
        })
        return Promise.resolve(result)
    }

    private async getParameterValues(parentResult?: any, previousActivityResult?: any): Promise<{
        [paramName: string]: any
    }> {
        const parameters: { [paramName: string]: any } = {}
        for (let [paramName, parameter] of Object.entries(this.parameters)) {
            parameters[paramName] = await parameter.getValue(parentResult, previousActivityResult)
        }
        // todo, we can refactor this. just use normal parameters, and check in the loop above if they are dynamic.
        for (let [paramName, paramDef] of Object.entries(this.dynamicParameters)) {
            try {
                const param = ActivityParameter.getActivityParameter(this, paramDef, this.service.getUIInput(), paramName)
                parameters[paramName] = await param.getValue(parentResult, previousActivityResult)
            } catch (e) {
                console.warn("Dynamic parameter failed", paramName, e)
            }
        }
        console.debug("parameters", parameters, "<-", this.parameters)
        return Promise.resolve(parameters)
    }

    private async callExec(parameters: any, requestBody: any): Promise<any> {
        try {
            console.log(parameters)
            console.debug("With execution-type:", this.execution.getExecutionType())
            const result = await this.execution.execute(parameters, requestBody)
            return Promise.resolve(result)
        } catch (e) {
            // trigger alert
            console.error(e)
            if (e.constructor.name === ActivityError.name)
                this.service.activityError(e)
            else {
                this.service.activityError(new ActivityError(this.service.title, this.title, 0, e))
            }
            return Promise.reject(e)
        }
    }

    /**
     * Call the activity from IDS
     * @param extParameters merge into parameters
     * @param extRequestBody overwrite requestBody
     */
    async externalCall(extParameters: { [paramName: string]: any }, extRequestBody?: any): Promise<any> {
        try {
            this.service.registerRunningActivity(this)
            const parameters = await this.getParameterValues()
            // merge parameters with assign
            Object.assign(parameters, extParameters)
            let requestBody: any
            if (extRequestBody) {
                requestBody = extRequestBody
            } else {
                requestBody = await this.getRequestBody()
            }
            return await this.callExec(parameters, requestBody)
        } catch (e) {
            console.error(e)
            return Promise.reject(e)
        } finally {
            this.service.activityFinished()
        }
    }


    private handleSpecialResult(result: any) {
        const resultAsOutputHtml = this.activityData().ui?.resultAsOutputHtml
        if (resultAsOutputHtml) {
            outputHtml(this.service, result, resultAsOutputHtml)
        } else if (this.activityData().ui?.resultAsDynamicUI !== undefined) {
            const dynUIElements = this.service.registerDynamicUIElements(result)
            buildDynamicUI(this.service, dynUIElements, this.activityData().ui?.resultAsDynamicUI)
        } else if (this.activityData().ui?.resultsAsOpenInput) {
            if (typeof this.activityData().ui?.resultsAsOpenInput === "string")
                addToOpenInputs(this.service, result, this.activityData().ui?.resultsAsOpenInput as string)
            else
                addToOpenInputs(this.service, result)
        }
    }

    /**
     * Store the results after execution
     * @param result
     */
    storeResult(result: any) {
        if (this.isActivityReference())
            return
        const storeResult = (this.data as ProcessServiceActivityType).storeResult
        if (storeResult) {
            // console.log("store", store.context, store.context === StoreContextEnum.PROCESS, store.context === "process")
            if (storeResult.context === StoreContextEnum.PROCESS) {
                console.debug("storing process", storeResult.key, ":", result)
                this.service.getProcess().setStoreValue(storeResult.key, result)
            } else if (storeResult.context === StoreContextEnum.ACTIVITY) {
                console.debug("storing activityStore", storeResult.key, ":", result)
                getToolkit().activityStore.setStoreValue(storeResult.key, result)
            } else { // default service
                console.debug("storing cache", storeResult.key, ":", result)
                this.service.setStoreValue(storeResult.key, result)
            }
            // console.debug("storing", this.storeKey, ":", result)
            // getToolkit().setStoreValue(this.storeKey, result)
        }
    }


    /**
     * Collect all inactive activities. also checks all subActivities so the result is a list.
     * todo: do we need this? buttons or triggers on inputs should be checking if their activities are inactive
     *
     * @return list of inactive activities
     */
    getInactiveActivities(): Activity[] {
        const inactiveActivities: Activity[] = []
        if (!this.active) {
            inactiveActivities.push(this)
        }
        for (let subActivity of Object.values(this.subActivities)) {
            inactiveActivities.push.apply(inactiveActivities, subActivity.getInactiveActivities())
        }
        return inactiveActivities
    }

    /**
     * Get the names of the parameters that are used in the execution of this activity
     */
    getExecutionParameterNames(): string[] {
        return this.execution.getParameterNames()
    }

    activityData(): ProcessServiceActivityType {
        return this.data as ProcessServiceActivityType
    }

    isActivityReference(): boolean {
        return "serviceName" in this.data
    }

    description(includeParameters: boolean = true,
                includeSubActivities: boolean = true): string {
        let result = `${this.service.title}:${this.title} [${this.service.name}:${this.name}]`
        if (!isEmpty(this.requiredActivities)) {
            result += "\nrequiredActivities: " + this.requiredActivities.map(a => JSON.stringify(a)).join(", ")
        }
        if (!this.isActivityReference()) {
            if (includeParameters) {
                result += "Parameters:\n"
                result += "\n" + Object.entries(this.parameters).map(([name, param]) => `${name}:${param.description()}`).join(", ")
            }
            const store = (this.data as ProcessServiceActivityType).storeResult
            if (store) {
                result += "\n" + `storeResult: ${JSON.stringify(store)}`
            }
        }

        result += "\nExecution: Type:" + this.execution.getExecutionType() + "\n" + this.execution.description()

        if (includeSubActivities) {
            if (typeof includeParameters === "boolean") {
                result += "\nSub-activities:\n" + Object.values(this.subActivities).map(a => a.description(false, false)).join("\n")
            }
        }
        return result
    }
}

type ActivityConfig = {
    alert: boolean
}