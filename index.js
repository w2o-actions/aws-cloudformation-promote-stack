const core = require('@actions/core');
const aws = require('aws-sdk');
const assert = require('assert');

const READY_STATES=[
    "CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE",
    "ROLLBACK_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "IMPORT_ROLLBACK_COMPLETE" ];

const TERMINAL_STATES=[
    "CREATE_COMPLETE", "CREATE_FAILED",
    "ROLLBACK_FAILED", "ROLLBACK_COMPLETE",
    "DELETE_FAILED", "DELETE_COMPLETE",
    "UPDATE_COMPLETE", "UPDATE_ROLLBACK_FAILED", "UPDATE_ROLLBACK_COMPLETE",
    "IMPORT_COMPLETE", "IMPORT_ROLLBACK_FAILED", "IMPORT_ROLLBACK_COMPLETE" ];

async function getStack(cloudformation, stackName) {
    var result;
    try {
        var stacks = await cloudformation.describeStacks({ StackName: stackName }).promise()
        result = stack.Stacks[0];
    }
    catch(e) {
        if(e.code == 'ValidationError') {
            // Stack does not exist
            result = null;
        } else
        if(e.code == 'SignatureDoesNotMatch') {
            // Bad credentials
            throw new Error(`The given credentials are invalid`);
        } else
        if(e.code == 'AccessDenied') {
            // Bad permissions
            throw new Error(`The given credentials do not have adequate permissions to describe stacks`);
        }
        else {
            // Generic failure
            throw new Error(`Failed to retrieve the source stack: `+e);
        }
    }
    return result;
}

async function run() {
    try {
        // Get inputs
        const sourceStackName = core.getInput('source-stack-name', { required: false });
        const ignoreSourceStackStatus = (core.getInput('ignore-source-stack-status', { required: false }) || 'false') == 'true';
        const targetStackName = core.getInput('target-stack-name', { required: false });
        const parameterOverridesString = core.getInput('parameter-overrides', { required: false });
        const roleArn = core.getInput('role-arn', { required: false});

        var parameterOverrides;
        try {
            parameterOverrides = JSON.parse(parameterOverridesString);
        }
        catch(e) {
            throw new Error(`The given parameter overrides failed to parse as JSON`);
        }

        const cloudformation = new aws.CloudFormation();

        // Retrieve our source stack
        var sourceStack=await getStack(cloudformation, sourceStackName).promise();
        if(sourceStack == null) {
            throw new Error(`The given source stack ${sourceStackName} does not exist`);
        }

        console.log(`Retrieved source stack ${sourceStack.StackId}`);
        
        // Confirm the stack is in an acceptable state
        if(ignoreSourceStackStatus) {
            console.log(`Ignored source stack status ${sourceStack.StackStatus}`);
        }
        else {
            if(READY_STATES.includes(sourceStack.StackStatus)) {
                console.log(`Accepted source stack status ${sourceStack.StackStatus}`);
            }
            else {
                throw new Error(`Source stack has unacceptable status ${sourceStack.StackStatus}`);
            }
        }

        // Retrieve our target stack
        var targetStack=await getStack(cloudformation, targetStackName).promise();
        if(targetStack) {
            if(READY_STATES.includes(targetStack.StackStatus)) {
                console.log(`Accepted target stack status ${targetStack.StackStatus}`);
            }
            else {
                throw new Error(`Target stack has unacceptable status ${targetStack.StackStatus}`);
            }
        }
        else {
            console.log(`Determined target stack does not exist, creating...`);
        }

        // Get our source template
        const sourceTemplate=await cloudformation.getTemplate({ StackName: sourceStackName, TemplateStage: "Original" })
            .promise()
            .TemplateBody;

        // Resolve our parameters
        const mergingParameters = {};
        sourceStack.Parameters.forEach(function(p) {
            mergingParameters[p.ParameterKey] = p.ParameterValue;
        });
        Object.entries(parameterOverrides).forEach(function(p) {
            mergingParameters[p[0]] = p[1];
        });
        const parameters = Object.entries(parameters)
            .map(p => ({ ParameterKey: p[0], ParameterValue: p[1] }));

        // Update our target stack
        if(targetStack) {
            // Our target stack already exists
            await cloudformation.updateStack({
                    StackName: targetStackName,
                    Capabilities: [ 'CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND' ],
                    Parameters: parameters,
                    RoleARN: roleArn,
                    TemplateBody: sourceTemplate,
                    UsePreviousTemplate: false
                }).promise()
            console.log(`Updated target stack ${targetStackName}`)
        }
        else {
            // Our target stack does not exist
            await cloudformation.createStack({
                    StackName: targetStackName,
                    OnFailure: 'DELETE',
                    Capabilities: [ 'CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND' ],
                    Parameters: parameters,
                    RoleARN: roleArn,
                    TemplateBody: sourceTemplate
                }).promise()
            console.log(`Created target stack ${targetStackName}`)
        }

        // Await our status
        var stack=await getStack(cloudformation, targetStackName).promise();
        while(stack && !TERMINAL_STATES.includes(stack.StackStatus)) {
            console.log(`Target stack ${targetStackName} in state ${stack.StackStatus}`)
            await new Promise(r => setTimeout(r, 15000));
            stack = await getStack(cloudformation, targetStackName).promise();
        }

        if(stack == null) {
            throw new Error(`Target staff failed to create and was deleted`);
        } else
        if(stack.StackStatus.includes("_FAILED")) {
            throw new Error(`Target staff failed to update in state ${stack.StackStatus}`);
        }

        console.log(`Target stack updated successfully in state ${stack.StackStatus}`);
    }
    catch (error) {
        core.setFailed(error.message);

        const showStackTrace = process.env.SHOW_STACK_TRACE;

        if (showStackTrace === 'true') {
            throw(error)
	}
    }
}

module.exports = run;

if (require.main === module) {
    run();
}
