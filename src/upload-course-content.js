'use strict';

const fs = require('fs');
const FormData = require('form-data');

module.exports = class UploadCourseContent {
	constructor(
		fetch = require('node-fetch'),
		ValenceAuth = require('./auth/valence-auth'),
		contentPath = './content'
	) {
		this._fetch = fetch;
		this._valence = new ValenceAuth({
			appId: process.env.VALENCE_APPID,
			appKey: process.env.VALENCE_APPKEY,
			userId: process.env.VALENCE_USERID,
			userKey: process.env.VALENCE_APPKEY
		});
		this._contentPath = contentPath;

		this._markdownRegex = /.md$/i;
	}

	/**
	 * Uploads course content to a Brightspace LMS
	 * @param {URL} instanceUrl
	 * @param {number} orgUnitId
	 */
	async uploadCourseContent(
		instanceUrl,
		orgUnitId
	) {
		const whoAmI = await this._whoAmI(instanceUrl);
		console.log(`Running in user context: ${whoAmI.UniqueName}`);

		const orgUnit = await this._getOrgUnit(instanceUrl, orgUnitId);
		console.log(`Found course offering: ${orgUnit.Name}`);

		const manifest = await this._getManifest();

		// Order matters on creates, so not using .map()
		for (const module of manifest.modules) {
			// eslint-disable-next-line no-await-in-loop
			await this._processModule(instanceUrl, orgUnit, module);
		}
	}

	async _processModule(instanceUrl, orgUnit, module, parentModule) {
		const items = await this._getContent(instanceUrl, orgUnit, parentModule);
		let self = Array.isArray(items) && items.find(m => m.Type === 0 && m.Title === module.title);

		if (self) {
			await this._updateModule(instanceUrl, orgUnit, module, self);
		} else {
			self = await this._createModule(instanceUrl, orgUnit, module, parentModule);
		}

		// Order matters on creates, so not using .map()
		for (const child of module.children) {
			if (child.type === 'topic') {
				// eslint-disable-next-line no-await-in-loop
				await this._processTopic(instanceUrl, orgUnit, child, self);
			} else {
				// eslint-disable-next-line no-await-in-loop
				await this._processModule(instanceUrl, orgUnit, child, self);
			}
		}
	}

	async _processTopic(instanceUrl, orgUnit, topic, parentModule) {
		const topics = await this._getContent(instanceUrl, orgUnit, parentModule);
		const self = Array.isArray(topics) && topics.find(t => t.Type === 1 && t.Title === topic.title);

		if (self) {
			await this._updateTopic(instanceUrl, orgUnit, topic, self);
			return self;
		}

		return this._createTopic(instanceUrl, orgUnit, topic, parentModule);
	}

	async _createModule(instanceUrl, orgUnit, module, parentModule) {
		const url = parentModule
			? new URL(`/d2l/api/le/1.34/${orgUnit.Id}/content/modules/${parentModule.Id}/structure/`, instanceUrl)
			: new URL(`/d2l/api/le/1.34/${orgUnit.Id}/content/root/`, instanceUrl);
		const signedUrl = this._valence.createAuthenticatedUrl(url, 'POST');

		const descriptionFileName = module.descriptionFileName.replace(this._markdownRegex, '.html');
		const description = await fs.promises.readFile(`${this._contentPath}/${descriptionFileName}`);

		// TODO: loose files

		const response = await this._fetch(
			signedUrl,
			{
				method: 'POST',
				body: JSON.stringify({
					Title: module.title,
					ShortTitle: module.title,
					Type: 0,
					ModuleStartDate: null,
					ModuleEndDate: null,
					ModuleDueDate: module.dueDate || null,
					IsHidden: false,
					IsLocked: false,
					Description: {
						Html: description.toString('utf-8')
					}
				})
			});

		return response.json();
	}

	async _createTopic(instanceUrl, orgUnit, topic, parentModule) {
		const url = new URL(`/d2l/api/le/1.34/${orgUnit.Id}/content/modules/${parentModule.Id}/structure/`, instanceUrl);
		const signedUrl = this._valence.createAuthenticatedUrl(url, 'POST');

		const fileName = topic.fileName.replace(this._markdownRegex, '.html');
		const fileContent = await fs.promises.readFile(`${this._contentPath}/${fileName}`);

		const formData = new FormData();
		formData.append(
			'',
			JSON.stringify({
				Title: topic.title,
				ShortTitle: topic.title,
				Type: 1,
				TopicType: 1,
				StartDate: null,
				EndDate: null,
				DueDate: topic.dueDate || null,
				Url: `${orgUnit.Path}${fileName}`,
				IsHidden: false,
				IsLocked: false
			}),
			{ contentType: 'application/json' }
		);
		formData.append(
			'',
			fileContent,
			{ contentType: 'text/html', filename: `${fileName}` }
		);

		const response = await this._fetch(
			signedUrl,
			{
				method: 'POST',
				headers: `multipart/mixed; ${formData.getBoundary()}`,
				body: formData
			});

		return response.json();
	}

	async _updateModule(instanceUrl, orgUnit, module, lmsModule) {
		const url = new URL(`/d2l/api/le/1.34/${orgUnit.Id}/content/modules/${lmsModule.Id}`, instanceUrl);
		const signedUrl = this._valence.createAuthenticatedUrl(url, 'PUT');

		const descriptionFileName = module.descriptionFileName.replace(this._markdownRegex, '.html');
		const description = await fs.promises.readFile(`${this._contentPath}/${descriptionFileName}`);

		const body = {
			...lmsModule,
			...{
				Title: module.title,
				ShortTitle: module.title,
				ModuleDueDate: module.dueDate || null,
				Description: {
					Html: description.toString('utf-8')
				}
			}
		};

		await this._fetch(
			signedUrl,
			{
				method: 'PUT',
				body: JSON.stringify(body)
			});

		return body;
	}

	async _updateTopic(instanceUrl, orgUnit, topic, lmsTopic) {
		const url = new URL(`/d2l/api/le/1.34/${orgUnit.Id}/content/topics/${lmsTopic.Id}`, instanceUrl);
		const signedUrl = this._valence.createAuthenticatedUrl(url, 'PUT');

		const fileName = topic.fileName.replace(this._markdownRegex, '.html');

		const body = {
			...lmsTopic,
			...{
				Title: topic.title,
				ShortTitle: topic.title,
				Url: `${orgUnit.Path}${fileName}`,
				DueDate: topic.dueDate || null,
				ResetCompletionTracking: true
			}
		};

		await this._fetch(
			signedUrl,
			{
				method: 'PUT',
				body: JSON.stringify(body)
			});

		const fileUrl = new URL(`/d2l/api/le/1.34/${orgUnit.Id}/content/topics/${lmsTopic.Id}/file`, instanceUrl);
		const signedFileUrl = this._valence.createAuthenticatedUrl(fileUrl, 'PUT');

		const fileContent = await fs.promises.readFile(`${this._contentPath}/${fileName}`);

		const formData = new FormData();
		formData.append(
			'file',
			fileContent,
			{ contentType: 'text/html', filename: `${fileName}` }
		);

		await this._fetch(
			signedFileUrl,
			{
				method: 'PUT',
				headers: {
					'Content-Type': 'multipart/mixed'
				},
				body: formData
			});

		return body;
	}

	async _getContent(instanceUrl, orgUnit, parentModule = null) {
		const url = parentModule
			? new URL(`/d2l/api/le/1.34/${orgUnit.Id}/content/modules/${parentModule.Id}/structure/`, instanceUrl)
			: new URL(`/d2l/api/le/1.34/${orgUnit.Id}/content/root/`, instanceUrl);
		const signedUrl = this._valence.createAuthenticatedUrl(url, 'GET');

		const response = await this._fetch(signedUrl);

		return response.json();
	}

	async _getManifest() {
		const manifest = await fs.promises.readFile(`${this._contentPath}/manifest.json`);

		return JSON.parse(manifest.toString('utf-8'));
	}

	async _getOrgUnit(instanceUrl, orgUnitId) {
		const url = new URL(`/d2l/api/lp/1.23/courses/${orgUnitId}`, instanceUrl);
		const signedUrl = this._valence.createAuthenticatedUrl(url, 'GET');

		const response = await this._fetch(signedUrl);

		return response.json();
	}

	async _whoAmI(instanceUrl) {
		const url = new URL('/d2l/api/lp/1.23/users/whoami', instanceUrl);
		const signedUrl = this._valence.createAuthenticatedUrl(url, 'GET');

		const response = await this._fetch(signedUrl);

		return response.json();
	}
};
