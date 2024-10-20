import * as vscode from 'vscode';
import * as fs from 'fs/promises';

export function activate(context: vscode.ExtensionContext) {
	const GEF_COLUMN_Z = 1;
	const GEF_COLUMN_QC = 2;
	const GEF_COLUMN_FS = 3;
	const GEF_COLUMN_U = 6;
	const GEF_COLUMN_Z_CORRECTED = 11;
	const CPT_FR_MAX = 10.0;

	class CptReadError extends Error {
		constructor(message: string) {
			super(message);
			this.name = "CptReadError";
		}
	}	

	class Cpt {
		x: number = 0.0;
		y: number = 0.0;
		top: number = 0.0;
		bottom: number = 0.0;
		z: number[] = [];
		qc: number[] = [];
		fs: number[] = [];
		u: number[] = [];
		fr: number[] = [];
		name: string = "";
		filedate: string = "";
		startdate: string = "";
		filename: string = "";
		preExcavatedDepth: number = 0.0;
		
		static fromString(data: string, suffix: string): Cpt {
			const cpt = new Cpt();
			suffix = suffix.toLowerCase();
			if (suffix === ".xml") {
				try {
					cpt.readXml(data);
					return cpt;
				} catch (e) {
					throw new CptReadError(`Error reading XmlCpt data; '${e}'`);
				}
			} else if (suffix === ".gef") {
				try {
					cpt.readGef(data);
					return cpt;
				} catch (e) {
					throw new CptReadError(`Error reading GEFCpt data; '${e}'`);
				}
			} else {
				throw new CptReadError(`Invalid or unsupported filetype '${suffix}', supported are *.gef, *.xml`);
			}
		}
	
		get xy(): [number, number] {
			return [this.x, this.y];
		}
	
		readGef(data: string): void {
			let readingHeader = true;
			const metadata: any = {
				recordSeparator: "",
				columnSeparator: " ",
				columnVoids: {},
				columnInfo: {},
			};
			const lines = data.split("\n");
			for (const line of lines) {
				if (readingHeader) {
					if (line.includes("#EOH")) {
						readingHeader = false;
					} else {
						this.parseHeaderLine(line, metadata);
					}
				} else {
					this.parseDataLine(line, metadata);
				}
			}
			this.postProcess();
		}
	
		get length(): number {
			return this.top - this.bottom;
		}
	
		get date(): string {
			if (this.startdate) {
				return this.startdate;
			} else if (this.filedate) {
				return this.filedate;
			} else {
				throw new Error("This CPT file has no valid date information.");
			}
		}
	
		get hasU(): boolean {
			return Math.max(...this.u) > 0 || Math.min(...this.u) < 0;
		}
	
		postProcess(): void {
			this.fr = [];
			for (let i = 0; i < this.qc.length; i++) {
				const qc = this.qc[i];
				const fs = this.fs[i];
				if (qc === 0.0) {
					this.fr.push(CPT_FR_MAX);
				} else {
					this.fr.push((fs / qc) * 100.0);
				}
			}
	
			const zs: number[] = [], qcs: number[] = [], fss: number[] = [], frs: number[] = [], u2s: number[] = [];
			for (let i = 0; i < this.z.length; i++) {
				let qc = this.qc[i];
				let fs = this.fs[i];
				let fr = this.fr[i];
				let u2 = this.u[i];
	
				if (isNaN(this.z[i])) {continue;}
				if (isNaN(qc)) {qc = 0.0;}
				if (isNaN(fs)) {fs = 0.0;}
				if (isNaN(fr)) {fr = 0.0;}
				if (isNaN(u2)) {u2 = 0;}
	
				zs.push(this.z[i]);
				qcs.push(qc);
				fss.push(fs);
				frs.push(fr);
				u2s.push(u2);
			}
	
			this.z = zs;
			this.qc = qcs;
			this.fs = fss;
			this.fr = frs;
			this.u = u2s;
	
			this.top = parseFloat(this.top.toFixed(2));
			this.bottom = parseFloat(this.z[this.z.length - 1].toFixed(2));
		}	

		private parseHeaderLine(line: string, metadata: any): void {
			try {
				const args = line.split("=");
				const keyword = args[0].trim().replace("#", "");
				const argline = args[1].trim();
				const params = argline.split(",");
	
				switch (keyword) {
					case "PROCEDURECODE":
					case "REPORTCODE":
						if (params[0].toUpperCase().includes("BORE")) {
							throw new CptReadError("This is a borehole file instead of a CPT file");
						}
						break;
					case "RECORDSEPARATOR":
						metadata.recordSeparator = params[0];
						break;
					case "COLUMNSEPARATOR":
						metadata.columnSeparator = params[0];
						break;
					case "COLUMNINFO":
						const column = parseInt(params[0]);
						let dtype = parseInt(params[3].trim());
						if (dtype === GEF_COLUMN_Z_CORRECTED) {dtype = GEF_COLUMN_Z;}
						metadata.columnInfo[dtype] = column - 1;
						break;
					case "XYID":
						this.x = parseFloat(parseFloat(params[1].trim()).toFixed(2));
						this.y = parseFloat(parseFloat(params[2].trim()).toFixed(2));
						break;
					case "ZID":
						this.top = parseFloat(params[1].trim());
						break;
					case "MEASUREMENTVAR":
						if (params[0] === "13") {
							this.preExcavatedDepth = parseFloat(params[1].trim());
						}
						break;
					case "COLUMNVOID":
						metadata.columnVoids[parseInt(params[0].trim()) - 1] = parseFloat(params[1].trim());
						break;
					case "TESTID":
						this.name = params[0].trim();
						break;
					case "FILEDATE":
						this.filedate = this.parseDate(params);
						break;
					case "STARTDATE":
						this.startdate = this.parseDate(params);
						break;
					default:
						break;
				}
			} catch (e) {
				throw new Error(`Error reading header line '${line}' -> ${e}`);
			}
		}

		private parseDate(params: string[]): string {
			try {
				const yyyy = parseInt(params[0].trim());
				const mm = parseInt(params[1].trim());
				const dd = parseInt(params[2].trim());
	
				if (yyyy < 1900 || yyyy > 2100 || mm < 1 || mm > 12 || dd < 1 || dd > 31) {
					throw new Error(`Invalid date ${yyyy}-${mm}-${dd}`);
				}
	
				return `${yyyy}${String(mm).padStart(2, '0')}${String(dd).padStart(2, '0')}`;
			} catch {
				return "";
			}
		}

		private parseDataLine(line: string, metadata: any): void {
			try {
				if (line.trim().length === 0) {return;}
				let args = line
					.replace(metadata.recordSeparator, '')
					.trim()
					.split(metadata.columnSeparator)
					.filter((arg: string) => arg.trim().length > 0)
					.map((arg: string) => parseFloat(arg.trim()));
	
				for (const [colIndex, voidValue] of Object.entries(metadata.columnVoids)) {
					if (args[parseInt(colIndex)] === voidValue) {return;}
				}
	
				const zColumn = metadata.columnInfo[GEF_COLUMN_Z];
				const qcColumn = metadata.columnInfo[GEF_COLUMN_QC];
				const fsColumn = metadata.columnInfo[GEF_COLUMN_FS];
				const uColumn = metadata.columnInfo[GEF_COLUMN_U] || -1;
	
				const dz = this.top - Math.abs(args[zColumn]);
				this.z.push(dz);
	
				let qc = args[qcColumn];
				if (qc <= 0) {qc = 1e-3;}
				this.qc.push(qc);
	
				let fs = args[fsColumn];
				if (fs <= 0) {fs = 1e-6;}
				this.fs.push(fs);
	
				if (uColumn > -1) {
					this.u.push(args[uColumn]);
				} else {
					this.u.push(0.0);
				}
			} catch (e) {
				throw new Error(`Error reading data line '${line}' -> ${e}`);
			}
		}

		readXml(data: string): void {
			// This method should parse the XML data
			throw new Error("XML parsing not implemented");
		}
	}
	
	let disposable = vscode.commands.registerCommand('extension.handleGefFile', async (uri: vscode.Uri) => {
		var os = require('os');
        try {
            // Read the file content as a buffer
            const content = await vscode.workspace.fs.readFile(uri);
            // Convert the buffer to a string
            const fileContent = content.toString();
			const cpt = Cpt.fromString(fileContent, ".gef");

			var data_string_qc = "[";
			var data_string_fr = "[";
			for(let i=0; i<cpt.z.length; i++){
				data_string_qc += `{x: ${cpt.qc[i]}, y: ${cpt.z[i]}},`;
				data_string_fr += `{x: ${cpt.fr[i]}, y: ${cpt.z[i]}},`;
			}
			data_string_qc += "]";
			data_string_fr += "]";
			
            // Show the content in an information message
            // vscode.window.showInformationMessage(`Content of ${uri.fsPath}: ${cpt.name}...`); // Show first 100 characters

			let panel = vscode.window.createWebviewPanel(
				"cptViewer", 
				"Cpt Viewer", 
				vscode.ViewColumn.One,
				{enableScripts: true}
			);
			panel.webview.html = getWebViewContent();

			context.subscriptions.push(disposable);

			function getWebViewContent(){
				return `
<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Scatter Chart</title>
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    </head>
    <body>
        <h1>${cpt.name}</h1>
        <canvas id="myScatterChart" width="400" height="400"></canvas>
        <script>
            const ctx = document.getElementById('myScatterChart').getContext('2d');

            const scatterChart = new Chart(ctx, {
                type: 'scatter',
                data: {
                    datasets: [
						{
                        	label: 'cone resistance',
                        	data: ${data_string_qc}, 
                        	backgroundColor: 'rgba(54, 162, 235, 0.75)',
							showLine: true,
							xAxisID: 'x'
                    	},
						{
                        	label: 'friction ratio',
                        	data: ${data_string_fr}, 
                        	backgroundColor: 'rgba(154, 62, 135, 0.75)',
							showLine: true,
							xAxisID: 'xAxis2'
                    	},
					]
                },
                options: {
                    scales: {
                        x: {
                            type: 'linear',
                            position: 'bottom',
							title: {
								display: true,
								text: 'Cone resistance [MPa]'
							},
							min: 0,
							max: 20,
                        },
						xAxis2: {
                            type: 'linear',
                            position: 'top',
							title: {
								display: true,
								text: 'Friction ratio [%]'
							},
							min: 0,
							max: 10,
                        },
                    }
                }
            });
            
        </script>
    </body>
    </html>
				`;
			}

        } catch (error) {
			const errorMessage = (error as Error).message || "Unknown error occurred.";
            vscode.window.showErrorMessage(`Failed to read file: ${errorMessage}`);
        }
    });	
}

// This method is called when your extension is deactivated
export function deactivate() {}
