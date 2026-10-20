import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, Loader2, ListVideo, Pause, Play, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getBatchTaskStatus, getBilibiliFavoritePage, type FavoriteVideo } from '@/services/favorites'
import { generateNote, type GenerateNotePayload } from '@/services/note'
import { useTaskStore, type FavoriteFolderInfo } from '@/store/taskStore'

const STORAGE_KEY = 'bilinote-favorite-batch-v1'
type BatchState = 'idle' | 'running' | 'paused' | 'done'
type GenerationConfig = Omit<GenerateNotePayload, 'video_url' | 'platform' | 'task_id'>

interface SavedBatch {
  favoriteUrl: string
  favoriteId: string
  favoriteTitle: string
  videos: FavoriteVideo[]
  selectedBvids: string[]
  page: number
  total: number
  hasMore: boolean
  config: GenerationConfig | null
  nextIndex: number
  state: BatchState
}

interface BatchError {
  code?: number
  message?: string
  msg?: string
  data?: {
    reason?: string
    downloading?: boolean
  }
}

interface FavoriteBatchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  getGenerationConfig: () => GenerationConfig | null
}

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

const FavoriteBatchDialog = ({ open, onOpenChange, getGenerationConfig }: FavoriteBatchDialogProps) => {
  const addPendingTask = useTaskStore(state => state.addPendingTask)
  const [hydrated, setHydrated] = useState(false)
  const [favoriteUrl, setFavoriteUrl] = useState('')
  const [favoriteId, setFavoriteId] = useState('')
  const [favoriteTitle, setFavoriteTitle] = useState('')
  const [videos, setVideos] = useState<FavoriteVideo[]>([])
  const [selectedBvids, setSelectedBvids] = useState<string[]>([])
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingAll, setLoadingAll] = useState(false)
  const [batchState, setBatchState] = useState<BatchState>('idle')
  const [pauseRequested, setPauseRequested] = useState(false)
  const [batchConfig, setBatchConfig] = useState<GenerationConfig | null>(null)
  const [nextIndex, setNextIndex] = useState(0)
  const [error, setError] = useState('')
  const stopAfterCurrent = useRef(false)
  const hasMoreRef = useRef(false)
  const pageRef = useRef(0)
  const videosRef = useRef<FavoriteVideo[]>([])

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const batch = JSON.parse(saved) as SavedBatch
        setFavoriteUrl(batch.favoriteUrl || '')
        setFavoriteId(batch.favoriteId || '')
        setFavoriteTitle(batch.favoriteTitle || '')
        setVideos(batch.videos || [])
        setSelectedBvids(batch.selectedBvids || [])
        setPage(batch.page || 0)
        setTotal(batch.total || 0)
        setHasMore(Boolean(batch.hasMore))
        setBatchConfig(batch.config || null)
        setNextIndex(batch.nextIndex || 0)
        setBatchState(batch.state === 'running' ? 'paused' : batch.state || 'idle')
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY)
    } finally {
      setHydrated(true)
    }
  }, [])

  useEffect(() => {
    pageRef.current = page
    hasMoreRef.current = hasMore
    videosRef.current = videos
  }, [page, hasMore, selectedBvids, videos])

  useEffect(() => {
    if (!hydrated) return
    const saved: SavedBatch = {
      favoriteUrl,
      favoriteId,
      favoriteTitle,
      videos,
      selectedBvids,
      page,
      total,
      hasMore,
      config: batchConfig,
      nextIndex,
      state: batchState,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
  }, [hydrated, favoriteUrl, favoriteId, favoriteTitle, videos, selectedBvids, page, total, hasMore, batchConfig, nextIndex, batchState])

  const fetchPage = async (pageNumber: number, replace = false) => {
    const result = await getBilibiliFavoritePage(favoriteUrl, pageNumber)
    setFavoriteId(result.favorite_id)
    pageRef.current = result.page
    hasMoreRef.current = result.has_more
    setFavoriteTitle(result.title)
    setTotal(result.media_count)
    setPage(result.page)
    setHasMore(result.has_more)
    setVideos(current => {
      const existing = new Set(replace ? [] : current.map(video => video.bvid))
      const incoming = result.videos.filter(video => !existing.has(video.bvid))
      return replace ? result.videos : [...current, ...incoming]
    })
    setSelectedBvids(current => {
      const base = replace ? [] : current
      return [...new Set([...base, ...result.videos.map(video => video.bvid)])]
    })
  }

  const previewFavorite = async () => {
    if (!favoriteUrl.trim()) {
      setError('请粘贴 Bilibili 收藏夹链接')
      return
    }
    setLoading(true)
    setError('')
    setVideos([])
    setSelectedBvids([])
    setFavoriteId('')
    setPage(0)
    setBatchState('idle')
    setBatchConfig(null)
    setNextIndex(0)
    try {
      await fetchPage(1, true)
    } catch (cause: unknown) {
      const failure = cause as BatchError
      setError(failure?.msg || failure?.message || '无法读取收藏夹，请检查 Cookie 和链接')
    } finally {
      setLoading(false)
    }
  }

  const loadAllPages = async () => {
    setLoadingAll(true)
    setError('')
    try {
      let nextPage = pageRef.current + 1
      while (hasMoreRef.current) {
        await delay(200)
        await fetchPage(nextPage)
        nextPage += 1
      }
    } catch (cause: unknown) {
      const failure = cause as BatchError
      setError(failure?.msg || failure?.message || '加载收藏夹后续视频失败')
    } finally {
      setLoadingAll(false)
    }
  }

  const updateVideo = (bvid: string, update: Partial<FavoriteVideo>) => {
    setVideos(current => current.map(video => video.bvid === bvid ? { ...video, ...update } : video))
  }

  const runBatch = async (
    items: FavoriteVideo[],
    config: GenerationConfig,
    startIndex: number,
    favoriteFolder: FavoriteFolderInfo,
  ) => {
    stopAfterCurrent.current = false
    setPauseRequested(false)
    setBatchState('running')
    setError('')

    for (let index = startIndex; index < items.length; index += 1) {
      if (stopAfterCurrent.current) {
        setNextIndex(index)
        setBatchState('paused')
        setPauseRequested(false)
        return
      }

      const video = videosRef.current.find(item => item.bvid === items[index].bvid) || items[index]
      if (video.status === 'success' || video.status === 'failed') {
        setNextIndex(index + 1)
        continue
      }

      updateVideo(video.bvid, { status: 'running', error: undefined })
      let taskId = video.task_id
      if (!taskId) {
        try {
          const payload: GenerateNotePayload = {
            ...config,
            style: config.style || 'minimal',
            video_url: video.video_url,
            platform: 'bilibili',
          }
          const response = await generateNote(payload, { silent: true })
          taskId = response?.task_id
          if (!taskId) throw new Error('后端没有返回任务编号')
          addPendingTask(taskId, 'bilibili', payload, favoriteFolder)
          updateVideo(video.bvid, { task_id: taskId })
        } catch (cause: unknown) {
          const failure = cause as BatchError
          if (failure?.data?.reason === 'transcriber_model_not_ready') {
            updateVideo(video.bvid, { status: undefined, error: undefined })
            setNextIndex(index)
            setBatchState('paused')
            setPauseRequested(false)
            setError(failure.data.downloading
              ? '转写模型正在下载，等模型准备好后点击继续。'
              : '当前转写模型尚未下载，请先到「设置 → 音频转写配置」下载模型。')
            return
          }
          updateVideo(video.bvid, {
            status: 'failed',
            error: failure?.msg || failure?.message || '提交任务失败',
          })
          setNextIndex(index + 1)
          continue
        }
      }

      while (true) {
        try {
          const status = await getBatchTaskStatus(taskId)
          if (status.status === 'SUCCESS') {
            updateVideo(video.bvid, { status: 'success', error: undefined })
            setNextIndex(index + 1)
            break
          }
          if (status.status === 'FAILED') {
            updateVideo(video.bvid, {
              status: 'failed',
              error: status.message || '笔记生成失败',
            })
            setNextIndex(index + 1)
            break
          }
          await delay(3000)
        } catch (cause: unknown) {
          const failure = cause as BatchError
          if (failure?.code === 500) {
            updateVideo(video.bvid, {
              status: 'failed',
              error: failure?.msg || '笔记生成失败',
            })
            setNextIndex(index + 1)
            break
          }
          setError(`无法确认「${video.title}」的任务状态，可点击继续重试查询。`)
          setNextIndex(index)
          setBatchState('paused')
          setPauseRequested(false)
          return
        }
      }
    }

    setNextIndex(items.length)
    setBatchState('done')
    setPauseRequested(false)
  }

  const startBatch = () => {
    const items = videos.filter(video => selectedBvids.includes(video.bvid))
    if (hasMore) {
      setError('请先加载完整个收藏夹，再开始批量生成')
      return
    }
    if (items.length === 0) {
      setError('请至少选择一个视频')
      return
    }
    const config = getGenerationConfig()
    if (!config) return
    setBatchConfig(config)
    setNextIndex(0)
    void runBatch(items, config, 0, {
      id: favoriteId || favoriteUrl.trim(),
      title: favoriteTitle || 'Bilibili 收藏夹',
      url: favoriteUrl.trim(),
    })
  }

  const resumeBatch = () => {
    if (!batchConfig) return
    const items = videos.filter(video => selectedBvids.includes(video.bvid))
    if (items.length === 0) {
      setError('没有可继续的已选视频')
      return
    }
    void runBatch(items, batchConfig, nextIndex, {
      id: favoriteId || favoriteUrl.trim(),
      title: favoriteTitle || 'Bilibili 收藏夹',
      url: favoriteUrl.trim(),
    })
  }

  const retryFailed = () => {
    const selectedVideos = videos.filter(video => selectedBvids.includes(video.bvid))
    const firstFailedIndex = selectedVideos.findIndex(video => video.status === 'failed')
    if (firstFailedIndex < 0) return

    const resetVideos = videos.map(video => selectedBvids.includes(video.bvid) && video.status === 'failed'
      ? { ...video, status: undefined, task_id: undefined, error: undefined }
      : video)
    setVideos(resetVideos)
    videosRef.current = resetVideos
    setNextIndex(firstFailedIndex)
    setBatchState('paused')
    setError('')
  }

  const pauseBatch = () => {
    if (batchState !== 'running' || pauseRequested) return
    stopAfterCurrent.current = true
    setPauseRequested(true)
  }

  const clearBatch = () => {
    if (batchState === 'running') return
    setVideos([])
    setSelectedBvids([])
    setFavoriteId('')
    setFavoriteTitle('')
    setPage(0)
    setTotal(0)
    setHasMore(false)
    setBatchConfig(null)
    setNextIndex(0)
    setBatchState('idle')
    setError('')
    localStorage.removeItem(STORAGE_KEY)
  }

  const toggleVideo = (bvid: string) => {
    setSelectedBvids(current => current.includes(bvid)
      ? current.filter(item => item !== bvid)
      : [...current, bvid])
  }

  const toggleAll = () => {
    setSelectedBvids(current => current.length === videos.length ? [] : videos.map(video => video.bvid))
  }

  const finishedCount = videos.filter(video =>
    selectedBvids.includes(video.bvid) && (video.status === 'success' || video.status === 'failed')
  ).length
  const selectedCount = videos.filter(video => selectedBvids.includes(video.bvid)).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-3xl flex-col gap-4 overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListVideo className="h-5 w-5" />
            Bilibili 收藏夹批量生成
          </DialogTitle>
          <DialogDescription>
            使用设置中保存的 Bilibili Cookie 读取私有收藏夹；批量任务复用当前笔记配置并逐个执行。
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Input
            value={favoriteUrl}
            onChange={event => setFavoriteUrl(event.target.value)}
            placeholder="粘贴收藏夹链接，例如 bilibili.com/list/ml..."
            disabled={batchState === 'running'}
          />
          <Button type="button" onClick={previewFavorite} disabled={loading || batchState === 'running'}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListVideo className="h-4 w-4" />}
            读取
          </Button>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {videos.length > 0 && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <div className="min-w-0">
                <span className="font-medium">{favoriteTitle}</span>
                <span className="ml-2 text-muted-foreground">
                  已载入 {videos.length} / {total}，已选 {selectedCount}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={toggleAll} disabled={batchConfig !== null || batchState === 'running'}>
                  {selectedCount === videos.length ? '取消全选' : '全选已载入'}
                </Button>
                {batchState !== 'running' && (
                  <Button type="button" variant="ghost" size="icon" title="清除批次" onClick={clearBatch}>
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>

            <ScrollArea className="min-h-0 flex-1 rounded border">
              <div className="divide-y">
                {videos.map(video => (
                  <label key={video.bvid} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/50">
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0 accent-primary"
                      checked={selectedBvids.includes(video.bvid)}
                      disabled={batchConfig !== null || batchState === 'running' || video.status === 'success' || video.status === 'failed'}
                      onChange={() => toggleVideo(video.bvid)}
                    />
                    {video.cover ? (
                      <img src={video.cover} alt="" loading="lazy" className="h-10 w-16 shrink-0 rounded object-cover" />
                    ) : (
                      <div className="h-10 w-16 shrink-0 rounded bg-muted" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{video.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[video.uploader, video.bvid].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    {video.status === 'running' && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                    {video.status === 'success' && <Check className="h-4 w-4 text-green-600" />}
                    {video.status === 'failed' && <span className="max-w-40 truncate text-xs text-red-600" title={video.error}>失败</span>}
                  </label>
                ))}
              </div>
            </ScrollArea>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm text-muted-foreground">
                {batchState === 'running'
                  ? pauseRequested
                    ? `当前视频完成后暂停 · ${finishedCount} / ${selectedCount}`
                    : `批量处理中 ${finishedCount} / ${selectedCount}，暂停会在当前视频完成后生效`
                  : batchState === 'done'
                    ? `批量完成：成功 ${videos.filter(video => video.status === 'success').length}，失败 ${videos.filter(video => video.status === 'failed').length}`
                    : batchState === 'paused'
                      ? `已暂停：完成 ${finishedCount} / ${selectedCount}`
                      : hasMore
                        ? '加载全部视频后才能开始，避免遗漏收藏夹内容'
                        : '每个视频完成后才会启动下一个'}
              </div>
              <div className="flex gap-2">
                {hasMore && (
                  <Button type="button" variant="outline" onClick={loadAllPages} disabled={loadingAll || batchState === 'running'}>
                    {loadingAll && <Loader2 className="h-4 w-4 animate-spin" />}
                    {loadingAll ? `加载中 ${videos.length} / ${total}` : '加载全部'}
                  </Button>
                )}
                {batchState === 'running' ? (
                  <Button type="button" variant="outline" onClick={pauseBatch} disabled={pauseRequested}>
                    {pauseRequested
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <Pause className="h-4 w-4" />}
                    {pauseRequested ? '正在暂停…' : '暂停'}
                  </Button>
                ) : batchState === 'done' && videos.some(video => selectedBvids.includes(video.bvid) && video.status === 'failed') ? (
                  <Button type="button" variant="outline" onClick={retryFailed}>
                    重试失败项
                  </Button>
                ) : batchState === 'paused' ? (
                  <Button type="button" onClick={resumeBatch}>
                    <Play className="h-4 w-4" />继续
                  </Button>
                ) : (
                  <Button type="button" onClick={startBatch} disabled={selectedCount === 0 || hasMore || loadingAll}>
                    <Play className="h-4 w-4" />开始批量生成
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

export default FavoriteBatchDialog
