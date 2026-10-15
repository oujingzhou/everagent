import { createServer } from "node:http";

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = Number(args[portIndex + 1]);
const submissions = new Map<string, number>();
let nextSubmission = 1;

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	if (request.method === "GET" && url.pathname === "/api/health") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ service: "everagent", token: process.env.EVERAGENT_DAEMON_TOKEN }));
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/state") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ messages: [], tasks: [], submissions: [] }));
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/messages") {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { requestId?: string };
		const key = body.requestId ?? `anonymous-${nextSubmission}`;
		const submissionId = submissions.get(key) ?? nextSubmission++;
		submissions.set(key, submissionId);
		response.writeHead(202, { "content-type": "application/json" });
		response.end(JSON.stringify({ submissionId, status: { status: "queued" } }));
		return;
	}
	response.writeHead(404).end();
});

await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
const stop = (): void => {
	server.close(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
