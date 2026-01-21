require("dotenv").config();
const express = require("express");
const fs = require("fs");
const { EC2Client, RunInstancesCommand, TerminateInstancesCommand, DescribeInstancesCommand } = require("@aws-sdk/client-ec2");
const { Client } = require("ssh2");
const http = require("http");
const WebSocket = require("ws");
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = 3000;

// AWS Configuration
const ec2Client = new EC2Client({
    region: process.env.AWS_REGION || "us-east-2",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

app.use(express.json());


// HELPER FUNCTION - gets instance public IP
async function getInstanceIP(instanceId) {
    const command = new DescribeInstancesCommand({
        InstanceIds: [instanceId]
    });

    const response = await ec2Client.send(command);
    const instance = response.Reservations[0]?.Instances[0];

    if (!instance) {
        throw new Error('Instance not found');
    }

    if (instance.State.Name !== 'running') {
        throw new Error(`Instance is ${instance.State.Name}, not running`);
    }

    if (!instance.PublicIpAddress) {
        throw new Error('Instance has no public IP yet');
    }

    return {
        publicIp: instance.PublicIpAddress,
        state: instance.State.Name
    };
}

app.post("/api/spawn", async (req, res) => {
    try {
        console.log("Spawning EC2 instance...");

        const params = {
            ImageId: process.env.AMI_ID,
            InstanceType: "c7i-flex.large",
            MinCount: 1,
            MaxCount: 1,
            SecurityGroupIds: ["sg-009df5b9900378325"],
            TagSpecifications: [
                {
                    ResourceType: "instance",
                    Tags: [
                        {
                            Key: "Name",
                            Value: `gemini-session-${Date.now()}`,
                        },
                    ],
                },
            ],
        };

        const command = new RunInstancesCommand(params);
        const data = await ec2Client.send(command);

        if (!data.Instances || data.Instances.length === 0) {
            throw new Error("No instances created");
        }

        const instanceId = data.Instances[0].InstanceId;
        console.log(`Created instance: ${instanceId}`);

        res.json({
            success: true,
            message: "EC2 instance spawned successfully",
            instanceId,
            status: "pending",
            publicDns: data.Instances[0].PublicDnsName || "pending",
        });
    } catch (error) {
        console.error("Error spawning EC2 instance:", error);
        res.status(500).json({
            success: false,
            message: "Failed to spawn EC2 instance",
            error: error.message,
        });
    }
});


app.delete("/api/destroy/:id", async (req, res) => {
    try {
        const instanceId = req.params.id;
        console.log(`Terminating instance: ${instanceId}`);

        const command = new TerminateInstancesCommand({
            InstanceIds: [instanceId],
        });

        const data = await ec2Client.send(command);

        res.json({
            success: true,
            message: "EC2 instance terminated successfully",
            instanceId,
            data,
        });
    } catch (error) {
        console.error("Error terminating EC2 instance:", error);
        res.status(500).json({
            success: false,
            message: "Failed to terminate instance",
            error: error.message,
        });
    }
});
app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

app.get("/ip/:id", async (req, res) => {
    const instanceId = req.params.id;
    const details = await getInstanceIP(instanceId);
    res.json(details)
});


// Web socket

wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, `ws://${req.headers.host}`);
    const instanceId = url.searchParams.get('instanceId');

    if (!instanceId) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Missing instanceId parameter'
        }));
        ws.close();
        return;
    }

    console.log(`WebSocket connection request for instance: ${instanceId}`);

    let instanceInfo;
    try {
        instanceInfo = await getInstanceIP(instanceId);
        console.log(`Instance ${instanceId} found at IP: ${instanceInfo.publicIp}`);
    } catch (error) {
        ws.send(JSON.stringify({
            type: 'error',
            message: error.message
        }));
        ws.close();
        return;
    }

    // ADD THIS - Create SSH client
    const sshClient = new Client();
    let shellStream = null;

    // ADD THIS - SSH configuration
    const sshConfig = {
        host: instanceInfo.publicIp,
        port: 22,
        username: process.env.SSH_USERNAME || 'ec2-user',
        privateKey: fs.readFileSync(process.env.SSH_KEY_PATH),
        readyTimeout: 30000
    };

    // ADD THIS - Handle SSH connection ready
    sshClient.on('ready', () => {
        console.log(`SSH connected to ${instanceId}`);

        ws.send(JSON.stringify({
            type: 'connected',
            message: 'SSH connection established'
        }));

        // Request a shell
        sshClient.shell({
            term: 'xterm-256color',
            cols: 80,
            rows: 30
        }, (err, stream) => {
            if (err) {
                console.error('Shell error:', err);
                ws.send(JSON.stringify({
                    type: 'error',
                    message: `Shell error: ${err.message}`
                }));
                ws.close();
                return;
            }

            console.log(`Shell opened for ${instanceId}`);
            shellStream = stream;

            // Forward shell output to WebSocket
            stream.on('data', (data) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'output',
                        data: data.toString('utf-8')
                    }));
                }
            });

            // Handle shell close
            stream.on('close', () => {
                console.log(`Shell closed for ${instanceId}`);
                ws.send(JSON.stringify({
                    type: 'exit',
                    message: 'Shell closed'
                }));
                ws.close();
            });
        });
    });

    // ADD THIS - Handle SSH errors
    sshClient.on('error', (err) => {
        console.error(`SSH error:`, err);
        ws.send(JSON.stringify({
            type: 'error',
            message: `SSH error: ${err.message}`
        }));
        ws.close();
    });

    // ADD THIS - Handle SSH close
    sshClient.on('close', () => {
        console.log(`SSH connection closed for ${instanceId}`);
        ws.close();
    });

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.type === 'input' && shellStream) {
                shellStream.write(msg.data);
            } else if (msg.type === 'resize' && shellStream) {  // ADD THIS
                if (msg.cols && msg.rows) {
                    shellStream.setWindow(msg.rows, msg.cols, 0, 0);
                }
            }
        } catch (e) {
            console.error('Error handling message:', e);
        }
    });

    // Handle WebSocket close
    ws.on('close', () => {
        console.log(`WebSocket closed for ${instanceId}`);
        sshClient.end();  // ADD THIS - close SSH when WebSocket closes
    });

    // ADD THIS - Actually connect to SSH
    try {
        console.log(`Connecting to SSH at ${instanceInfo.publicIp}...`);
        sshClient.connect(sshConfig);
    } catch (error) {
        console.error('SSH connection failed:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: `Connection failed: ${error.message}`
        }));
        ws.close();
    }
});

server.listen(PORT, () => {
    console.log(`Listening to port ${PORT}`);
    console.log(`WebSocket server ready`);
});


