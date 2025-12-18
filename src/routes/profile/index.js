import verifyAuth from '../../middlewares/verifyAuth.js'
import fileUpload from 'express-fileupload'
import bcrypt from 'bcrypt-nodejs'
import express from 'express'
import path from 'path'
import fs from 'fs'

export default function ({ db, ensurePfp }) {
  const router = express.Router()

  router.get('/', verifyAuth(), async (req, res) => {
    await ensurePfp(req.user._id)
    res.render('profile', { title: _CC.lang('PROFILE_TITLE', req.user._id) })
  })

  const INFO_KEYS = [
    'shoeSize',
    'ringSize',
    'dressSize',
    'sweaterSize',
    'shirtSize',
    'pantsSize',
    'coatSize',
    'hatSize',
    'phoneModel',
  ]
  router.post('/info', verifyAuth(), async (req, res) => {
    if (!req.user.info) {
      req.user.info = {}
    }
    for (const [k, v] of Object.entries(req.body)) {
      console.log({ k, v })
      if (!INFO_KEYS.includes(k)) continue
      req.user.info[k] = v
    }
    await db.put(req.user)
    req.flash('success', _CC.lang('PROFILE_UPDATE_INFO_SUCCESS'))
    res.redirect('/profile')
  })

  router.get('/password', verifyAuth(), async (req, res) => {
    await ensurePfp(req.user._id)
    res.render('profile-password', {
      title: _CC.lang('PROFILE_PASSWORD_TITLE', req.user._id),
    })
  })

  router.post('/password', verifyAuth(), (req, res) => {
    if (!req.body.oldPassword) {
      req.flash('error', _CC.lang('PROFILE_PASSWORD_REQUIRED_OLD'))
      return res.redirect('/profile/password')
    }
    if (!req.body.newPassword) {
      req.flash('error', _CC.lang('PROFILE_PASSWORD_REQUIRED_NEW'))
      return res.redirect('/profile/password')
    }
    bcrypt.compare(req.body.oldPassword, req.user.password, (err, correct) => {
      if (err) throw err
      if (correct) {
        bcrypt.hash(req.body.newPassword, null, null, (err, hash) => {
          if (err) throw err
          db.get(req.user._id)
            .then((doc) => {
              doc.password = hash
              db.put(doc)
                .then(() => {
                  req.flash('success', _CC.lang('PROFILE_PASSWORD_SUCCESS'))
                  res.redirect('/profile/password')
                })
                .catch((err) => {
                  throw err
                })
            })
            .catch((err) => {
              throw err
            })
        })
      } else {
        req.flash('error', _CC.lang('PROFILE_PASSWORD_OLD_MISMATCH'))
        res.redirect('/profile/password')
      }
    })
  })

  router.post('/upload-pfp', fileUpload(), verifyAuth(), async (req, res) => {
    // Check that a file was uploaded
    if (!req.files?.profilePicture) {
      req.flash('error', _CC.lang('PROFILE_PFP_UPLOAD_NO_FILE'))
      return res.redirect('/profile')
    }

    const profilePicture = req.files.profilePicture
    const allowedExtensions = /png|jpg|jpeg/
    const extName = path.extname(profilePicture.name).toLowerCase()
    const oldPfp = req.user.pfp

    // Validate file type
    if (
      !allowedExtensions.test(
        path.extname(profilePicture.name).toLowerCase(),
      ) ||
      !allowedExtensions.test(profilePicture.mimetype)
    ) {
      req.flash('error', _CC.lang('PROFILE_PFP_UPLOAD_FILE_TYPE'))
      return res.redirect('/profile')
    }

    // Validate file size (e.g., n MB limit)
    const maxSize = _CC.config.pfpUploadMaxSize * 1024 * 1024 // n MB
    if (profilePicture.size > maxSize) {
      req.flash('error', _CC.lang('PROFILE_PFP_UPLOAD_FILE_SIZE'))
      return res.redirect('/profile')
    }

    // Generate unique filename and save file
    const fileName = `${Date.now()}${extName}`
    const uploadPath = path.join(_CC.uploadDir, fileName)
    try {
      await profilePicture.mv(uploadPath)
      // Update the user object
      req.user.pfp = { file: fileName }
      await db.put(req.user)
      req.flash('success', _CC.lang('PROFILE_PFP_UPLOAD_SUCCESS'))
    } catch (err) {
      console.error(err)
      req.flash('error', _CC.lang('PROFILE_PFP_UPLOAD_ERROR'))
    }

    if (oldPfp?.file) {
      try {
        // Delete old profile picture if it exists
        await fs.promises.unlink(path.join(_CC.uploadDir, oldPfp.file))
      } catch {
        // Probably didn't exist
      }
    }

    res.redirect('/profile')
  })

  // Liste toutes les promesses faites par l'utilisateur, groupées par propriétaire (owner)
  router.get('/pledges', verifyAuth(), async (req, res) => {
    try {
      const docs = await db.allDocs({ include_docs: true })
      const groups = {}

      for (const row of docs.rows) {
        const owner = row.doc._id
        const wishlist = row.doc.wishlist || []
        for (const item of wishlist) {
          if (item.pledgedBy === req.user._id) {
            const pledge = {
              owner,
              id: item.id,
              name: item.name || (item.url ? item.url : ''),
              price: item.price,
              image: item.image,
              url: item.url,
              note: item.note,
              addedBy: item.addedBy,
              purchased: !!item.purchased,
            }

            if (!groups[owner]) groups[owner] = []
            groups[owner].push(pledge)
          }
        }
      }

      const pledgesByOwner = Object.keys(groups)
        .sort((a, b) => a.localeCompare(b))
        .map((owner) => ({ owner, pledges: groups[owner] }))

      res.render('pledges', {
        title: _CC.lang('NAVBAR_PLEDGES'),
        pledgesByOwner,
      })
    } catch (err) {
      req.flash('error', `${err}`)
      res.redirect('/profile')
    }
  })

  // Basculer l'état "acheté" d'une promesse (seul le pledgeur peut le faire)
  router.post(
    '/pledges/:owner/:itemId/purchased',
    verifyAuth(),
    async (req, res) => {
      try {
        const owner = req.params.owner
        const itemId = req.params.itemId

        const wishlist = await _CC.wishlistManager.get(owner)
        const item = await wishlist.get(itemId)

        // Seul celui qui a promis peut marquer comme acheté
        if (item.pledgedBy !== req.user._id) {
          throw new Error('Vous n\'avez pas promis cet article')
        }

        item.purchased = !item.purchased
        await wishlist.save()

        req.flash(
          'success',
          item.purchased ? 'Marqué comme acheté' : 'Marqué comme non-acheté',
        )
      } catch (err) {
        req.flash('error', `${err}`)
      }

      res.redirect('/profile/pledges')
    },
  )

  return router
}
